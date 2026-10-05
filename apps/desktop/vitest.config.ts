import { defineConfig } from "vitest/config";

export default defineConfig({
  // 本机 /etc/hosts 的 localhost 映射损坏（历史遗留），显式绑 127.0.0.1
  server: { host: "127.0.0.1" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
