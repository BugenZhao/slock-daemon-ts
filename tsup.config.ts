import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/chat-bridge.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  sourcemap: true,
  dts: true,
  clean: true,
  splitting: false,
});
