import { FlatCompat } from "@eslint/eslintrc";
import { globalIgnores } from "eslint/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const baseDirectory = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory });

const config = [
  ...compat.extends("next/core-web-vitals"),
  globalIgnores([".next/**", "node_modules/**", "coverage/**"]),
];

export default config;
