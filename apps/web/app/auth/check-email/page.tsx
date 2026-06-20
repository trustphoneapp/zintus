export default function CheckEmailPage() {
  return (
    <div className="auth-container">
      <h1 className="auth-title">Check your inbox</h1>
      <p className="auth-sub">
        A sign-in link is on its way. It expires in 15 minutes.
      </p>
      <p className="auth-sub auth-muted">
        If you don't see it, check your spam folder.
      </p>
      <a href="/login" className="auth-link-btn">
        ← Back to sign in
      </a>
    </div>
  );
}
