# Unfolder Project Working Notes

This document records a read-only pass through the project logic as of this
directory. The pass covered:

- `src/App.jsx`: the main UI shell, delegating rendering to background workers.
- `src/index.css`, `package.json`, and `vite.config.js`: app shell/build setup.
- Parent reference notes under `../docs/source-study/`, especially the architecture,
  unfolding, code-sequence, and frontend notes from the larger billiards project.

This React app is not the full proof-grade periodic billiards system described in
the parent docs. It is a standalone floating-point visual workbench for finite
triangle unfoldings. Its value is exploratory: it helps inspect encoded poolshot
unfoldings that are relevant to the invisible-point conjecture, but it does not
currently certify the conjecture by exact arithmetic.

## Conjecture Context

The target problem stated for this app is not periodic paths. The intended
conjecture is:

```text
A point is invisible iff x divides 90 and y = k*x for some k >= 1 with y < z.
```

The right-to-left direction is known externally:

```text
x divides 90 and y = k*x and k >= 1 and y < z  =>  point is invisible.
```

The desired converse is:

```text
point is invisible  =>  x divides 90 and y = k*x and k >= 1 and y < z.
```

In this project, `x`, `y`, and `z` should be read as symbolic triangle angles
with `x + y + z = 180 deg`, usually with `x <= y < z` when discussing the
conjectural classification. The app itself does not yet enforce that sorting,
does not test divisibility of `90/x`, and does not prove invisibility. It lets
the user construct a triangle and inspect finite reflection/unfolding patterns
that may support or refute candidate mechanisms for the converse.

## What The App Solves

The app solves a visualization and sanity-check problem:

1. Build a Euclidean triangle from either explicit coordinates or two angles and
   a base length.
2. Generate reflected copies of that triangle by mirroring across sides.
3. Either:
   - follow a direct ray through reflected triangles, or
   - parse a compact integer code into symbolic angle runs and unfold a triangle
     chain from that code.
4. Display the unfolded chain, side labels, vertex coordinates, and the line from
   the original `A` vertex to the final reflected `A` vertex.

The core idea is the standard billiard unfolding trick: instead of reflecting a
ray at a side, reflect the triangle across that side. The billiard path then
becomes a straight line in the unfolded plane. This is useful for a poolshot
validation workflow because a complicated reflected shot can be inspected as one
straight geometric relationship through copied rooms.

## What The App Does Not Yet Solve

The current app does not:

- prove invisibility;
- decide the iff conjecture;
- validate that an integer code is legal, primitive, canonical, closed, or stable;
- implement exact rational or interval arithmetic;
- compute MRRs, covers, or positivity certificates;
- classify stable versus unstable code sequences;
- check `x divides 90` or `y = k*x`;
- detect all singular hits or forbidden vertex crossings in code mode.

All geometry in this React app uses JavaScript `Number` values, so the output is
floating-point evidence and visualization only.

## Project Layout

```text
.
|-- index.html
|-- package.json
|-- vite.config.js
|-- src/
|   |-- main.jsx
|   |-- index.css
|   |-- App.jsx
|   |-- anglePlot/ (workers and renderers)
|   |-- graphLibrary/ (database panels)
|   `-- sequences/ (setup cards)
|-- server/ (PostgreSQL graph database)
`-- public/
    |-- favicon.svg
    `-- icons.svg
```

Runtime stack:

- Vite serves and builds the app.
- React renders the app.
- Tailwind CSS utilities are enabled through `@tailwindcss/vite` and
  `@import "tailwindcss";` in `src/index.css`.
- `lucide-react` supplies UI icons.

Most geometric state originates from `src/App.jsx`, but computation is now delegated to `src/anglePlot/backgroundExactWorker.js` to prevent UI freezing. The app also features a Node.js/PostgreSQL backend (`server/`) for shared graph persistence.

## Coordinate Systems

The app uses two coordinate systems.

Mathematical plane:

- `x` increases to the right.
- `y` increases upward.
- Triangle points are stored in this plane.
- Reflection, angle, side, and centroid calculations use this plane.

SVG screen plane:

- `x` increases to the right.
- `y` increases downward.
- The render transform flips the vertical axis:

```text
translate(screen_center)
scale(zoom, -zoom)
translate(-pan)
```

`pan` is the mathematical coordinate placed at the center of the viewer.
`zoom` is screen pixels per mathematical unit.

Screen-space helper formulas:

```text
screen_x = width / 2 + (math_x - pan.x) * zoom
screen_y = height / 2 - (math_y - pan.y) * zoom
```

## Triangle And Side Conventions

A triangle is stored as three vertices:

```text
points[0] = A
points[1] = B
points[2] = C
```

Edges are zero-based and cyclic:

```text
edge 0 = A-B
edge 1 = B-C
edge 2 = C-A
```

The displayed side numbers follow the usual "side opposite vertex" convention:

```text
edge 0 (A-B), opposite C -> side 3
edge 1 (B-C), opposite A -> side 1
edge 2 (C-A), opposite B -> side 2
```

This mapping is stored as:

```text
EDGE_TO_SIDE = { 0: 3, 1: 1, 2: 2 }
```

An angle at a vertex is incident to two edges:

```text
vertex A / index 0 -> edges [0, 2]
vertex B / index 1 -> edges [0, 1]
vertex C / index 2 -> edges [1, 2]
```

## Core Math

### Reflection Across A Side

`reflectPoint(p, p1, p2)` reflects point `p` across the infinite line through
`p1` and `p2`.

The line is represented as:

```text
a*x + b*y + c = 0

a = p2.y - p1.y
b = p1.x - p2.x
c = p2.x*p1.y - p1.x*p2.y
```

For any point `p`, the signed scaled distance to the line is:

```text
d = (a*p.x + b*p.y + c) / (a*a + b*b)
```

The reflected point is:

```text
p' = p - 2*d*(a, b)
```

Pseudocode:

```text
function reflectPoint(p, p1, p2):
    a = p2.y - p1.y
    b = p1.x - p2.x
    c = p2.x*p1.y - p1.x*p2.y
    denom = a*a + b*b
    if denom == 0:
        return copy(p)
    factor = 2 * (a*p.x + b*p.y + c) / denom
    return (p.x - a*factor, p.y - b*factor)
```

### Triangle Centroid

`getCentroid(tri)` returns the arithmetic mean of the three vertices.

Pseudocode:

```text
function getCentroid(tri):
    return (
        (tri[0].x + tri[1].x + tri[2].x) / 3,
        (tri[0].y + tri[1].y + tri[2].y) / 3
    )
```

### Candidate Reflected Centroid

`testCentroid(tri, edge)` predicts where the triangle centroid would move if the
triangle were reflected across one edge. It reflects only the opposite vertex,
because the two vertices on the mirror edge remain fixed.

Pseudocode:

```text
function testCentroid(tri, edge):
    p1 = tri[edge]
    p2 = tri[(edge + 1) mod 3]
    p3 = tri[(edge + 2) mod 3]
    reflected = reflectPoint(p3, p1, p2)
    return centroid(p1, p2, reflected)
```

This is used by code mode to choose between two possible incident edges when it
needs a forward continuation direction.

### Angle At A Vertex

`getAngleAtVertex(p1, p2, p3)` returns the internal angle at `p2` using the law
of cosines. It computes squared side lengths, clamps the cosine into `[-1, 1]`,
and returns radians.

Pseudocode:

```text
function getAngleAtVertex(p1, p2, p3):
    a2 = distance_squared(p1, p3)
    b2 = distance_squared(p1, p2)
    c2 = distance_squared(p3, p2)
    if b2 == 0 or c2 == 0:
        return 0
    cos_value = (b2 + c2 - a2) / (2 * sqrt(b2) * sqrt(c2))
    cos_value = clamp(cos_value, -1, 1)
    return arccos(cos_value)
```

### Global Trajectory Angle

`getGlobalAngle(startP, endP)` reports the angle of the line from `startP` to
`endP` in degrees on `[0, 360)`.

Pseudocode:

```text
function getGlobalAngle(start, end):
    dx = end.x - start.x
    dy = end.y - start.y
    theta = atan2(dy, dx) * 180 / pi
    if theta < 0:
        theta += 360
    return theta
```

## Base Triangle Construction

The app has two base input modes.

Coordinate mode:

```text
A = user coordinate 0
B = user coordinate 1
C = user coordinate 2
```

Angle mode:

- User supplies angle `A`, angle `B`, and base length `L = |AB|`.
- The third angle is `C = 180 - A - B`.
- If the data are invalid, the app falls back to a simple nondegenerate triangle.
- Otherwise it places:

```text
A = (0, 0)
B = (L, 0)
```

Since side `AB` is opposite angle `C`, the law of sines gives side `AC`:

```text
|AC| = L * sin(B) / sin(C)
```

Then:

```text
C = |AC| * (cos(A), sin(A))
```

Pseudocode:

```text
function buildBaseTriangle(inputMode):
    if inputMode == "coords":
        return numeric copies of the three input points

    A = numeric angle A in degrees
    B = numeric angle B in degrees
    L = numeric base length
    C_angle = 180 - A - B

    if A <= 0 or B <= 0 or C_angle <= 0 or L <= 0:
        return fallback triangle

    side_AC = L * sin(B) / sin(C_angle)
    return [
        (0, 0),
        (L, 0),
        (side_AC*cos(A), side_AC*sin(A))
    ]
```

## Ray Simulator

Ray mode is the app's direct billiard-style simulator. It starts from a selected
base vertex, shoots at a user angle, and repeatedly reflects the triangle across
the next side hit by the straight ray.

Important detail: the origin `O` and direction `D` are fixed in the unfolded
plane. The app does not reflect the ray direction; it reflects the triangle.

For each reflected triangle:

1. Intersect ray `O + t*D` against each edge segment `V1 + u*E`.
2. Ignore parallel edges.
3. Keep intersections where:
   - `t` is ahead of the previous hit, and
   - `u` lies on the segment.
4. Select the smallest valid `t`.
5. If no edge is hit, stop.
6. If the hit lands exactly on the selected start vertex copy, stop rendering.
7. Reflect the triangle across the hit edge and continue.

Line intersection equations:

```text
O + t*D = V1 + u*E

denom = cross(D, E)
t = cross(V1 - O, E) / denom
u = cross(V1 - O, D) / denom
```

Pseudocode:

```text
function rayUnfold(baseTriangle, startVertex, rayAngle, maxBounces):
    O = baseTriangle[startVertex]
    D = (cos(rayAngle), sin(rayAngle))
    currentTri = baseTriangle
    currentRayT = 0
    reflectedTriangles = []

    for bounce in 0 .. maxBounces - 1:
        bestT = infinity
        bestEdge = null

        for edge in [0, 1, 2]:
            V1 = currentTri[edge]
            V2 = currentTri[(edge + 1) mod 3]
            E = V2 - V1
            denom = cross(D, E)
            if abs(denom) is tiny:
                continue

            diff = V1 - O
            t = cross(diff, E) / denom
            u = cross(diff, D) / denom

            if t > currentRayT + epsilon and -epsilon <= u <= 1 + epsilon:
                if t < bestT:
                    bestT = t
                    bestEdge = edge

        if bestEdge is null:
            break

        hit = O + bestT * D
        if distance_squared(hit, currentTri[startVertex]) < epsilon:
            currentRayT = bestT
            break

        currentTri = reflectTriangleAcrossEdge(currentTri, bestEdge)
        append currentTri to reflectedTriangles
        currentRayT = bestT

    return reflectedTriangles and displayed ray line
```

Improvement over a naive attempt:

- A naive simulator would update the ray direction after every wall hit and then
  fight accumulated angle/reflection state.
- The unfolding method keeps the ray as one fixed straight line and transforms
  only triangle copies. That makes visual validation of a multi-bounce path much
  easier.

## Code Unfolder

Code mode is the app's main finite unfolding workbench. It accepts a
space-separated list of positive integers and interprets them as the sizes of
successive triangle fans.

It deterministically reconstructs one finite fan tower from the code. It does
not prove that every input code is a legal periodic billiard code.

### Parsing The Integer Code

Input text is split on whitespace. Each token is parsed as an integer; invalid
tokens are discarded.

The first fan is `y`, centered at the right acute vertex. The ray starts in the
wedge between `AB` and `BC`, so its first crossed side is `BC`, opposite the
source angle `x`. After each fan, the next fan center is the other endpoint of
the last reflected side. This produces the same parity evolution as a code
sequence without guessing a label from run lengths or screen coordinates.

### Mapping Symbolic Angles To Physical Vertices

The symbolic frame is fixed by the physical starting triangle:

```text
x -> A (left/source acute vertex)
y -> B (right acute vertex)
z -> C (top obtuse vertex)
```

This invariant preserves the meaning of a code while angles are edited and makes
short codes independent of run-length ties.

### Choosing Edges For A Symbolic Angle

Once a symbol maps to a physical vertex, the app gets the two incident edges:

```text
vertex 0 -> [0, 2]
vertex 1 -> [0, 1]
vertex 2 -> [1, 2]
```

Each run alternates between the two edges incident to its fan center. The edge
before the first fan is `AB`; therefore the first emitted edge is `BC`. Every
later emitted edge is simply the incident edge other than the preceding edge.
When a fan finishes, the other endpoint of its final edge is the next fan center.
There is no centroid, viewport, or coordinate-quadrant tie-breaker.

### Reflecting The Code Chain

For every parsed step:

1. Determine the two edges incident to that symbolic angle.
2. Pick the starting edge.
3. Repeat `count` times:
   - record the standard side number;
   - reflect the triangle across the current edge;
   - append the reflected triangle;
   - update centroid and direction;
   - alternate to the other edge.
4. Stop at `MAX_TRIS = 3000`.

Pseudocode:

```text
function codeUnfold(baseTriangle, codeNumbers):
    currentTri = baseTriangle
    previousEdge = AB
    fanVertex = B
    triangles = []
    sideSequence = []
    triCount = 0

    for count in codeNumbers:
        edges = incidentEdges(fanVertex)

        for j from 0 to count - 1:
            if triCount >= MAX_TRIS:
                break all loops

            currentEdge = the edge in edges other than previousEdge
            sideSequence.append(EDGE_TO_SIDE[currentEdge])

            nextTri = reflectTriangleAcrossEdge(currentTri, currentEdge)
            triangles.append(nextTri)

            currentTri = nextTri
            previousEdge = currentEdge
            triCount += 1

        fanVertex = otherEndpoint(previousEdge, fanVertex)

    return triangles and sideSequence
```

The output shown in the UI:

- `parsedSequence`: each count with its symbolic angle label.
- `sideSequence`: each actual side crossed/reflected, using side labels `1, 2, 3`.
- `reflectionEdges`: each physical edge index crossed/reflected, using edge
  indices `0, 1, 2`; the formal tower-color validator uses this because side
  labels alone are display-oriented.
- `triangles`: reflected triangle copies.
- final shot-vector endpoint coordinate and global angle from the original
  physical `A` to the final physical `A`, displayed as `x/A`.

## Rendering And Interaction Algorithms

### Active Geometry Router

Only one simulation mode is active at a time:

```text
if simulatorMode == "ray":
    activeTriangles = rayData.triangles
else:
    activeTriangles = codeData.triangles
```

The app uses:

```text
shotVertexIdx = 0
shotSymbol = labelsMap[shotVertexIdx]
startShot = baseTriangle.points[shotVertexIdx]
finalShot = activeTriangles[last].points[shotVertexIdx] if any reflected triangles exist else startShot
line = startShot -> finalShot
```

That line is the main visual trajectory proxy in code mode. The validator uses
the literal line through these two endpoints and evaluates it at each candidate
vertex x coordinate. Physical `A` carries symbolic label `x`, so the sidebar
shows this vector as `x/A`.

### Finite Tower Line Validation

The validator follows finite unfolding-poolshot rules adapted from
`Obtuse Billiards.pdf`. The paper is primarily about periodic paths, but this app
does not use the periodic XYZ equation or the CS/CNS/OSO/ONS/OSNO classification
machinery. It borrows the finite tower-coloring and fan philosophy, then applies
the direct line-side predicate requested for this exploratory workbench.

The tower-coloring rule is:

1. `A0` is formal blue.
2. `B0` is formal black, rendered red in this UI.
3. When a reflected tower side has one endpoint already colored, the other
   endpoint receives the opposite formal color.
4. The recorded `reflectionEdges` provide the exact tower sides used for this
   propagation.
5. The two sides incident to final reflected physical `A` are treated as
   terminal sides, because the visual shot ends at the singular final `A`
   endpoint and either incident side can complete the displayed tower strip.

After formal coloring, every physical `A`, `B`, and `C` occurrence is validated.
Occurrences are keyed by triangle id, physical vertex index, and symbolic label,
so physical `C` vertices are tracked even when their coordinates move under angle
perturbation.

Every numeric code block is also checked as one finite fan. If a block is
`count` and its symbolic angle is `s`, then the fan central angle is:

```text
centralAngle = count * actualAngle(s)
```

The finite poolshot fan condition used here is:

```text
centralAngle < 180 degrees
```

The inspector reports the maximum central angle over all code blocks as
`max fan`, so the active code numbers can be compared directly against the
current triangle angles.

For the endpoint line from `startShot` to `finalShot`, each vertex point `p`
receives a direct line comparison:

```text
slope = (finalShot.y - startShot.y) / (finalShot.x - startShot.x)
lineY(p.x) = startShot.y + slope * (p.x - startShot.x)
dy(p) = p.y - lineY(p.x)
```

The current all-vertex condition is:

```text
blue vertices: dy(p) > epsilon
red vertices:  dy(p) < -epsilon
```

The epsilon input is applied directly in y-coordinate units. A tiny
floating-point floor remains in place so exact-boundary tests are not dominated
by roundoff. Vertical shot lines are rejected in this iteration because
`lineY(x)` is undefined for them; that case can receive a separate x-side
predicate later if needed.

Endpoint coordinates are not skipped for coloring or display. They are, however,
ignored as obstruction contributors because the visual shot definitionally starts
and ends at those singular coordinates. This prevents the final `A` occurrence
from invalidating its own shot while still allowing all non-endpoint `A`, `B`,
and `C` occurrences to participate in the line-side test.

Pseudocode:

```text
function validateShot(baseTriangle, activeTriangles, labelsMap, epsilon):
    shotLine = first physical A -> final physical A
    tolerance = max(1e-12, epsilon)
    if shotLine has zero length:
        invalid
    if shotLine is vertical:
        invalid
    colors = propagateTowerColors(baseTriangle, activeTriangles, reflectionEdges)
    for each code block:
        centralAngle = block.count * actualAngle(block.symbol)
        if centralAngle >= 180deg:
            invalid
    for each triangle in [baseTriangle] + activeTriangles:
        for each physical vertex index:
            symbol = labelsMap[index]
            occurrence = triangle.id + index + symbol
            role = colors[occurrence]
            if vertex coordinate is first or final shot endpoint:
                display it but skip the obstruction test
            if role is missing:
                invalid
            lineY = evaluate shotLine at vertex.x
            dy = vertex.y - lineY
            if role == blue:
                require dy > tolerance
            if role == red:
                require dy < -tolerance
```

The tower-color propagation step is:

```text
function propagateTowerColors(baseTriangle, activeTriangles, reflectionEdges):
    color(base A) = blue
    color(base B) = red
    for each reflected triangle:
        edge = reflectionEdges[i]
        on the previous triangle, color unknown endpoint of edge as opposite
        copy both endpoint colors across the shared reflected edge
        on the new triangle, require/copy opposite colors across the same edge
    on the final reflected triangle:
        color both sides incident to final physical A by the same rule
    during line validation:
        display endpoint coordinates, but do not use them as obstructions
```

### Constrained And Ghost Shot

Constrained mode protects the current valid code-mode shot by validating the
proposed candidate before React state is updated. The candidate must preserve the
current symbolic angle mapping, reflected side sequence, and physical reflection
edge sequence. It must also satisfy every numeric fan bound and the tower
line predicate. If any of these fail, the input is rejected and the last
valid geometry remains visible.

Ghost mode allows invalid candidates. Invalid Ghost geometry is rendered with
lower-opacity reflected triangles and a red shot vector so the failure can be
inspected without confusing it for a constrained valid state. Valid Ghost
geometry uses the same green shot vector as constrained valid geometry. Ghost
mode captures the finite code path when it starts, so a later exploratory edit
that changes the reflected path also turns the shot invalid.

### Stable Region Search

The `Find Stable Region` command searches a bounded local connected region in
symbolic `x` and `y` angle space. It keeps the current symbolic-to-physical
mapping, side sequence, and all-vertex line predicate fixed. It refines the grid
at `0.1`, `0.01`, and `0.001` degree steps and returns open intervals for the
discovered local component.

This is a floating-point exploratory region finder, not interval arithmetic. It
has a local radius and per-step visit cap to prevent browser lockups.

Pseudocode:

```text
function findStableRegion(centerX, centerY):
    for step in [0.1, 0.01, 0.001]:
        bfs from current x,y sample
        reject candidates outside local window
        reject candidates with nonpositive x, y, or z = 180 - x - y
        rebuild the physical triangle from symbolic x,y,z
        unfold the same code
        require same label map and same side sequence
        require the all-vertex line test to be valid
        collect min/max valid x and y samples
        shrink next search window around the valid component
    return open intervals expanded by the final step
```

### Fit To Screen

The fit command computes the bounding box of the base triangle plus all active
reflected triangles, centers the viewport on that box, and sets zoom so the box
fits inside the current SVG area with padding.

Pseudocode:

```text
function fitScreen():
    allTriangles = [baseTriangle] + activeTriangles
    minX, minY = infinity
    maxX, maxY = -infinity

    for tri in allTriangles:
        for p in tri.points:
            expand bounds with p

    width = max(maxX - minX, 1)
    height = max(maxY - minY, 1)
    pan = center of bounds
    zoom = min((svgWidth - 100) / width, (svgHeight - 100) / height)
```

### Grid Lines

Grid spacing depends on zoom:

```text
if zoom > 150: step = 1
else if zoom > 50: step = 2
else if zoom > 15: step = 10
else: step = 50
```

The app computes visible mathematical bounds from `pan`, `zoom`, and SVG size,
then emits vertical and horizontal SVG lines at multiples of `step`.

Pseudocode:

```text
function buildGrid(pan, zoom, svgSize):
    choose step from zoom
    minX = pan.x - (svgWidth / 2) / zoom
    maxX = pan.x + (svgWidth / 2) / zoom
    minY = pan.y - (svgHeight / 2) / zoom
    maxY = pan.y + (svgHeight / 2) / zoom

    linesX = multiples of step from floor(minX / step) * step to maxX
    linesY = multiples of step from floor(minY / step) * step to maxY
    return linesX, linesY, bounds
```

### Pan And Zoom

Panning:

```text
on mouse down:
    store current mouse position and set isDragging

on mouse move while dragging:
    dx = screen_dx / zoom
    dy = screen_dy / zoom
    pan.x -= dx
    pan.y += dy
```

The `pan.y` update is inverted because mathematical `y` increases upward while
screen `y` increases downward.

Zooming:

```text
on wheel:
    prevent browser scroll
    if wheel up: zoom *= 1.1
    if wheel down: zoom /= 1.1
    clamp zoom to [0.5, 5000]
```

### Screen-Space Annotations

Most geometry is drawn inside the scaled/flipped SVG group. Labels are drawn in a
separate unscaled group so text remains readable at every zoom level.

Base angle labels:

1. Compute base triangle centroid in mathematical coordinates.
2. Convert each vertex and the centroid to screen coordinates.
3. Move the label from the vertex toward the centroid by up to 22 pixels.
4. Render the current symbolic label for that vertex.

Hover labels:

1. If persistent labels are off, check whether the mouse is within 30 screen
   pixels of any vertex in a triangle.
2. If a triangle is active for labels, render unique vertex coordinates and side
   midpoint labels.
3. Deduplicate labels by rounded coordinate or midpoint.

Display precision:

1. The `Display Decimals` control defaults to 12 decimal places.
2. Coordinate logs, hover coordinates, final endpoint coordinates, global
   `atan2`, stable-region intervals, fan angles, and line-test diagnostics all
   use the same display precision.
3. The value is clamped to 0 through 15 decimals because the app uses browser
   double-precision numbers.
4. Internal stable-region cache keys keep their own rounding because that
   rounding is part of the search algorithm, not the visible display format.

Angle increment:

1. The `Angle Step` control changes the native stepper increment for Angle A and
   Angle B, and supplies the exact grid step for the valid-angle plot.
2. `Step Increment` independently controls the native spinner/arrow increment of
   the `Angle Step` field itself, replacing the former hard-coded `0.0001`.
3. `Angle Step` defaults to `0.1` degrees and `Step Increment` defaults to
   `0.0001`; both accept other positive decimal values.
4. Invalid or incomplete increment text temporarily falls back to its default
   without overwriting what the user is typing.
5. Constrained mode still validates candidate angle values before committing
   them, regardless of the selected increments.

Vertex color logic:

- Original `A` and final reflected `A` still get green endpoint circles on the
  drawn shot vector.
- The code-mode shot vector is green when the all-vertex line test is valid and
  red when it is invalid.
- Formal blue tower vertices are blue.
- Formal black tower vertices are rendered red.
- Vertices without a propagated formal color are yellow and invalid.
- Invalid line-test vertices receive a red ring/label while keeping their formal
  role color visible.
- Invalid Ghost geometry is ghosted by lowering reflected-triangle opacity.
- Derived triangle labels use that triangle's color when no code-mode tower
  validation override applies.

## Relationship To The Parent Billiards Project

The parent docs describe a much broader Java/C++ system for periodic triangular
billiards:

- It validates and canonicalizes code sequences.
- It classifies code types such as `OSO`, `OSNO`, `ONS`, `CS`, and `CNS`.
- It builds symbolic unfoldings.
- It derives trigonometric equations and shooting vectors.
- It computes exact rational bounding regions.
- It refines regions with interval arithmetic.
- It stores and renders stable/unstable MRRs and cover certificates.

This React app borrows the geometric intuition of unfolding, and its parity rule
for angle-label evolution matches the larger code-sequence model. It does not
use the larger proof pipeline.

For the invisible-point conjecture, this distinction matters. The app is useful
for inspecting candidate finite shot structures, but a completed proof tool would
need at least:

1. Exact representation of the angle family `x | 90`, `y = k*x`, `y < z`.
2. Explicit sorted-angle convention for `x`, `y`, and `z`.
3. A precise definition of the invisible point in app terms.
4. A validation algorithm that checks whether every admissible straight segment
   from source to target is blocked, or whatever formal visibility predicate is
   intended.
5. Exact or interval-certified arithmetic for all boundary/singularity cases.
6. A clear bridge from finite poolshot unfoldings to the converse direction.

## Improvements Over A More Naive Viewer

The current app already improves on a naive attempt in several practical ways:

- It uses unfolding instead of repeated ray-direction reflection, making long
  paths visually straight and easier to inspect.
- It reflects the opposite triangle vertex across a side rather than rebuilding a
  triangle from angles after every step.
- It records the actual side sequence while reflecting, so the geometric picture
  and the side-code output can be compared.
- It validates every formal tower-colored `A`, `B`, and `C` occurrence rather
  than assuming fan vertices are the only relevant obstruction.
- It can reject invalid angle edits in Constrained mode before they update the
  rendered geometry.
- It can inspect invalid candidates in Ghost mode without losing the
  visual distinction between constrained and exploratory states.
- It can estimate a bounded local stable `x`/`y` angle region for the current
  code and all-vertex line condition.
- It caches expensive derived geometry with React `useMemo`.
- It caps code-mode output at 3000 triangles to avoid locking the browser.
- It renders text labels in screen space, so zooming does not make labels vanish
  or overwhelm the canvas.
- It separates visual pan/zoom transforms from mathematical coordinates, so
  rendering does not mutate geometry.

## Main Limitations And Next Algorithmic Steps

The most important limitations are mathematical, not UI-related:

- Code mode deterministically unfolds its finite fan chain, but it still does
  not establish that an arbitrary code has a periodic realization.
- The app should distinguish exploratory double geometry from proof-grade exact
  geometry in the UI and data model.
- The conjecture conditions should become first-class inputs:

```text
x in degrees
k integer >= 1
y = k*x
z = 180 - x - y
constraints: x > 0, y > 0, y < z, 90 / x is integer
```

- The app should implement a formal invisible-point predicate before claiming
  validation.
- The current stable-region search is local, capped, and grid-based; it should
  not be confused with the exact rational/interval region machinery in the
  parent project.
- The current epsilon is a floating-point y-coordinate tolerance, not a proof
  certificate.
- Singular hits should be handled consistently in both ray and code modes.
- If a future backend is added, the React app should pass a structured problem
  instance rather than relying on displayed floating-point coordinates.

## Quick Mental Model

Use the app this way:

1. Choose a triangle.
2. Enter a finite code or ray.
3. Let the app unfold the triangle chain by reflection.
4. Inspect whether the `A -> final A` shot vector, side sequence, and formal
   blue/red line-side roles match the intended poolshot/invisibility mechanism.
5. Treat the result as a visual hypothesis generator, not a proof.

The shortest accurate description is:

```text
This project is a dark React/SVG workbench for visualizing finite unfolded
triangle poolshots relevant to an invisible-point conjecture. It uses
floating-point reflection geometry and a deterministic code-to-fan parser. It does
not yet prove visibility, invisibility, or the conjectured classification.
```

## Regression Testing

The CI math suite lives in `tests/math-regression.test.mjs` and runs with
Node's built-in test runner. It deliberately avoids the browser and React so it
can focus on the floating-point geometry and algorithms:

1. Reflection invariants.
2. Angle-mode triangle construction.
3. Default code parsing, symbolic mapping, side sequence, and reflection edges.
4. Symbolic angle round-tripping.
5. All-vertex blue/red line validation.
6. Known valid and invalid angle perturbations.
7. Fan central-angle rejection.
8. Code-path consistency.
9. Stable-region search around the known valid sample.
10. `atan2` quadrant handling.

The separate `.github/workflows/ci.yml` workflow runs on pushes to every branch.
It performs `npm ci`, `npm test`, `npm run lint`, and `npm run build`. The Pages
deployment workflow remains main-only.
