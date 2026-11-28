import { fileURLToPath, URL } from "node:url"
import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL(".", import.meta.url))
  const env = loadEnv(mode, envDir, "BACKEND_")

  return {
    envDir,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: env.BACKEND_URL || "http://localhost:3000",
          changeOrigin: true,
        },
      },
    },
  }
})