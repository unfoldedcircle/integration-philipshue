import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/", "docs/", "node_modules/", "tools/"]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierRecommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2022
      }
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "none"
        }
      ],
      "prettier/prettier": [
        "error",
        {
          semi: true,
          trailingComma: "none",
          singleQuote: false,
          printWidth: 120,
          endOfLine: "auto"
        }
      ]
    }
  }
);
