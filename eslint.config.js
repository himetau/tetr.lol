import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "test/**/*.ts", "tools/**/*.ts"],
    languageOptions: { parser: tsParser },
    rules: {
      curly: ["error", "all"],
    },
  },
];
