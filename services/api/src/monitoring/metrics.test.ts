import { it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { parseConfig } from "../config";
import { testEnv } from "../test-config";
import { createMetrics } from "./metrics";
it("records actual response categories and histogram samples without path/query cardinality", async () => {
  const metrics = createMetrics(),
    app = createApp(
      parseConfig(testEnv),
      { ready: true },
      undefined,
      undefined,
      undefined,
      metrics,
    );
  try {
    await request(app)
      .get("/api/v1/streams/opaque-visitor-a?secret=not-a-real-credential")
      .expect(404);
    await request(app).get("/api/v1/streams/opaque-visitor-b").expect(404);
    await request(app).get("/api/v1/health/live").expect(200);
    const data = await metrics.registry.metrics();
    expect(data).toContain('route="/api/v1/streams/:id",category="4xx"} 2');
    expect(data).toContain(
      'streamshield_http_request_duration_seconds_count{method="GET",route="/api/v1/streams/:id"} 2',
    );
    expect(data).toContain("streamshield_http_inflight 0");
    expect(data).not.toContain("opaque-visitor");
    expect(data).not.toContain("not-a-real-credential");
  } finally {
    metrics.registry.clear();
  }
});
