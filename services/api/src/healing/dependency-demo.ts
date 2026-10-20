import express from "express";
/** Deliberately simulated read-only upstream. No payments, writes or public control API. */
const app = express();
app.disable("x-powered-by");
app.get("/status", (_req, res) =>
  res.json({
    status: "available",
    simulated: true,
    recommendations: ["Discover a live channel"],
    writesSupported: false,
  }),
);
const port = Number(process.env.HEALER_DEMO_PORT || 4024);
const server = app.listen(port, "0.0.0.0");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
