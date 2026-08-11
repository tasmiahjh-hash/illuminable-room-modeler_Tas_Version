import { useAuth, AUTH_STATUS } from './useAuth.js';
import LoginScreen from './LoginScreen.jsx';
import App from '../App.jsx';

// The app's single entry-point gate: owns the one useAuth() call for the
// whole tree (see useAuth.js's own comment on why this is a plain prop,
// not context) and decides Login screen vs. the app shell. Kept as its own
// tiny component (not inlined in main.jsx) so it's independently testable/
// readable rather than mixed into the root-render bootstrap.
const AuthGate = () => {
  const auth = useAuth();

  if (auth.status === AUTH_STATUS.CHECKING) {
    // A stored ("stay signed in") token is being re-validated against the
    // server — see useAuth's own mount effect. Deliberately minimal: this
    // is usually on-screen for well under a second.
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-[#080b0f] text-slate-500 text-sm">
        Loading…
      </div>
    );
  }

  if (auth.status === AUTH_STATUS.UNSET) {
    return <LoginScreen auth={auth} />;
  }

  return <App auth={auth} />;
};

export default AuthGate;
