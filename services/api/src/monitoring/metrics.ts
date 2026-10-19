import type { RequestHandler } from "express";
import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
} from "@prometheus-io/client";
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "streamshield_" });
  const requests = new Counter({
    name: "streamshield_http_requests_total",
    help: "Completed or aborted HTTP requests, normalized route only",
    labelNames: ["method", "route", "category"],
    registers: [registry],
  });
  const latency = new Histogram({
    name: "streamshield_http_request_duration_seconds",
    help: "HTTP response duration in seconds",
    labelNames: ["method", "route"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const inflight = new Gauge({
    name: "streamshield_http_inflight",
    help: "Unfinished HTTP requests",
    registers: [registry],
  });
  const sockets = new Gauge({
    name: "streamshield_socket_connections",
    help: "Locally connected Socket.IO clients",
    registers: [registry],
  });
  const middleware: RequestHandler = (req, res, next) => {
    inflight.inc();
    const start = performance.now();
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      inflight.dec();
      const method = [
        "GET",
        "POST",
        "PATCH",
        "DELETE",
        "OPTIONS",
        "HEAD",
      ].includes(req.method)
        ? req.method
        : "OTHER";
      const path =
        typeof req.route?.path === "string"
          ? String(req.route.path)
          : "unmatched";
      // Only server route templates, never raw paths, query strings or user identifiers.
      requests.inc({
        method,
        route: path,
        category: res.writableFinished
          ? Math.floor(res.statusCode / 100) + "xx"
          : "aborted",
      });
      latency.observe(
        { method, route: path },
        (performance.now() - start) / 1000,
      );
    };
    res.once("finish", finish);
    res.once("close", finish);
    next();
  };
  return { registry, middleware, sockets };
}
export type ApiMetrics = ReturnType<typeof createMetrics>;
