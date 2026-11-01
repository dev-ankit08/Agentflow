import { describe, expect, it } from "vitest";
import { originAllowed } from "../src/routes/widget";

const widget = (allowedOrigins: string[]) => ({ allowedOrigins }) as Parameters<typeof originAllowed>[1];
const builder = "https://trial-3100.app.github.dev";

describe("widget origins", () => {
  it("allows local pages and the builder's own Live preview when no websites are listed", () => {
    expect(originAllowed("http://localhost:3100", widget([]), builder)).toBe(true);
    expect(originAllowed(builder, widget([]), builder)).toBe(true);
    expect(originAllowed("https://elsewhere.example", widget([]), builder)).toBe(false);
  });

  it("allows only the listed websites (and the builder) once some are listed", () => {
    const listed = widget(["https://shop.example"]);
    expect(originAllowed("https://shop.example", listed, builder)).toBe(true);
    expect(originAllowed(builder, listed, builder)).toBe(true);
    expect(originAllowed("http://localhost:3100", listed, builder)).toBe(false);
  });
});
