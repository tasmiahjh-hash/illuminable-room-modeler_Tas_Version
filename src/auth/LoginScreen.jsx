import { useState } from 'react';
import { Loader2 } from 'lucide-react';

// The app's very first screen (see main.jsx's AuthGate) — three ways in,
// per the spec: Continue as Guest (no account, temporary/local-only —
// see App.jsx's own guest-mode gating), Sign In, Create Account. Styled to
// match the rest of the app's existing dark palette (bg-[#080b0f]/
// bg-[#0b1016]/border-white/10/cyan accents — see App.jsx) rather than
// introducing a second visual language for one screen.
const LoginScreen = ({ auth }) => {
  const [mode, setMode] = useState('signIn'); // 'signIn' | 'createAccount'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    const ok = mode === 'signIn'
      ? await auth.signIn({ email, password })
      : await auth.signUp({ email, password, displayName });
    setSubmitting(false);
    if (!ok) return; // auth.error is already set; the form stays filled in so the user can just fix it and resubmit.
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#080b0f] text-slate-200 font-sans px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="text-xl font-bold text-slate-100">illuminable-room-modeler</h1>
          <p className="text-xs text-slate-500 mt-1">Research Database System</p>
        </div>

        <div className="bg-[#0b1016] border border-white/10 rounded-lg shadow-[0_8px_28px_rgba(0,0,0,0.22)] p-5">
          <div className="grid grid-cols-2 gap-1 rounded-md border border-white/10 bg-[#080b0f] p-1 mb-4">
            <button
              type="button"
              onClick={() => setMode('signIn')}
              className={`rounded px-2.5 py-1.5 text-[11px] font-bold transition-colors ${mode === 'signIn' ? 'bg-cyan-500/20 text-cyan-100' : 'text-slate-500 hover:text-slate-200'}`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => setMode('createAccount')}
              className={`rounded px-2.5 py-1.5 text-[11px] font-bold transition-colors ${mode === 'createAccount' ? 'bg-cyan-500/20 text-cyan-100' : 'text-slate-500 hover:text-slate-200'}`}
            >
              Create Account
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            {mode === 'createAccount' && (
              <label className="block">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Name</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your name"
                  className="mt-1 w-full bg-[#080b0f] border border-white/10 rounded px-2.5 py-1.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
                />
              </label>
            )}
            <label className="block">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1 w-full bg-[#080b0f] border border-white/10 rounded px-2.5 py-1.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Password</span>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'createAccount' ? 'At least 8 characters' : '••••••••'}
                className="mt-1 w-full bg-[#080b0f] border border-white/10 rounded px-2.5 py-1.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
              />
            </label>

            {auth.error && (
              <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-300/25 rounded px-2.5 py-1.5">
                {auth.error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 disabled:opacity-50 border border-cyan-300/30 text-cyan-100 px-3 py-2 rounded-md text-sm font-bold transition-colors"
            >
              {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {mode === 'signIn' ? 'Sign In' : 'Create Account'}
            </button>
          </form>
        </div>

        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-white/10" />
          <span className="text-[10px] text-slate-600 uppercase tracking-wider">or</span>
          <div className="flex-1 h-px bg-white/10" />
        </div>

        <button
          type="button"
          onClick={auth.continueAsGuest}
          className="w-full bg-[#0b1016] hover:bg-[#151c24] border border-white/10 text-slate-300 px-3 py-2 rounded-md text-sm font-bold transition-colors"
        >
          Continue as Guest
        </button>
        <p className="text-center text-[10px] text-slate-600 mt-2 leading-relaxed">
          Guest mode is temporary — plotting and settings only. Graphs aren&rsquo;t saved,
          and the Graph Database, Cloud Workspace Library, export, and import aren&rsquo;t available.
        </p>
      </div>
    </div>
  );
};

export default LoginScreen;
