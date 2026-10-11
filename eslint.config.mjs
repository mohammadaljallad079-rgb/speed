import next from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tseslint from "typescript-eslint";

// Native flat config. The previous FlatCompat version failed with
// "Converting circular structure to JSON", which made `npm run lint` unusable.
export default [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "**/*.bak"],
  },
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs}"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    plugins: { "@next/next": next, "react-hooks": reactHooks, "@typescript-eslint": tsPlugin },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
      "react/no-unescaped-entities": "off",
      "@next/next/no-img-element": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    // Test files legitimately use `module` as a local variable name; the Next
    // rule targets application source, not tests.
    files: ["tests/**/*.{ts,tsx}"],
    rules: { "@next/next/no-assign-module-variable": "off" },
  },
];
