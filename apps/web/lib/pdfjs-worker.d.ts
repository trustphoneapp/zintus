// The pdf.js worker build ships no type declarations. We import it only for its
// side effect — registering `WorkerMessageHandler` so pdf.js runs on the main
// thread (see lib/extract-pdf.ts). A bare module declaration is all we need.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
