import Nav from "./Nav";

export default function Page({
  title,
  description,
  active,
  children,
}: {
  title: string;
  description: string;
  active?: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      <Nav active={active} />
      <main>
        <header className="page-header">
          <h1>{title}</h1>
          <p className="page-description">{description}</p>
        </header>
        {children}
      </main>
    </>
  );
}
