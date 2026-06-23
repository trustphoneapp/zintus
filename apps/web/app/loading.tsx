export default function Loading() {
  return (
    <div className="home-skeleton" aria-hidden>
      <div className="home-skeleton-nav">
        <span className="sk-bar" style={{ width: 110 }} />
        <span className="sk-bar" style={{ width: 220 }} />
        <span className="sk-bar" style={{ width: 90 }} />
      </div>
      <div className="home-skeleton-hero">
        <span className="sk-bar sk-lg" style={{ width: "60%" }} />
        <span className="sk-bar sk-lg" style={{ width: "45%" }} />
        <span className="sk-bar" style={{ width: "70%", marginTop: 16 }} />
        <span className="sk-bar" style={{ width: "55%" }} />
        <span className="sk-btn" style={{ marginTop: 24 }} />
      </div>
      <div className="home-skeleton-content">
        <span className="sk-block" />
        <span className="sk-block" />
        <span className="sk-block" />
      </div>
    </div>
  );
}
