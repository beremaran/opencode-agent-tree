import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["dist/**", ".test-dist/**", "coverage/**", "node_modules/**"],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts"],
        rules: {
            curly: ["error", "all"],
            "@typescript-eslint/no-unused-vars": ["error", {argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_"}],
        },
    },
    {
        files: ["test/**/*.mjs"],
        languageOptions: {
            globals: {
                console: "readonly",
                fetch: "readonly",
                process: "readonly",
                Buffer: "readonly",
                clearTimeout: "readonly",
                setTimeout: "readonly",
            },
        },
    },
);
