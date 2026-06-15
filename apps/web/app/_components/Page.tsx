import Nav from "./Nav";

export default function Page({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      <Nav />
      <main>
        <header className="page-header">
          <h1>{title}</h1>
          {description ? <p className="page-description">{description}</p> : null}
        </header>
        {children}
      </main>
    </>
  );
}
