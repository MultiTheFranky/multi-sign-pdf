import { createApp } from "./app.js";

const { app, store } = createApp();
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "0.0.0.0", () =>
  console.log(`Servidor disponible en http://localhost:${port}`),
);
server.requestTimeout = 120000;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
