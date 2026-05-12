import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/fx/",   // matches GitHub Pages repo path zacld/fx
});
