import { expect, it } from "vitest";
import { promValue } from "./prom-value.js";
it.each([
  undefined,
  { status: "success", data: { result: [{ value: [1, ""] }] } },
  { status: "error" },
  { status: "success", data: { result: [] } },
  { status: "success", data: { result: [{ value: [1, "NaN"] }] } },
  { status: "success", data: { result: [{ value: [1, "Infinity"] }] } },
])("does not manufacture a healthy metric from %j", (body) =>
  expect(() => promValue(body)).toThrow(),
);
it("accepts an actually observed zero and finite positive values", () => {
  for (const value of ["0", "20.5"])
    expect(
      promValue({
        status: "success",
        data: { result: [{ value: [1, value] }] },
      }),
    ).toBe(Number(value));
});
