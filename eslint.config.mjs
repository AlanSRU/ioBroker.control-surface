// ioBroker eslint template configuration file for js and ts files
// Please note that esm or react based modules need additional modules loaded.
import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        // specify files to exclude from linting here
        ignores: [
            '.dev-server/',
            '.vscode/',
            '*.test.js',
            'test/**/*.js',
            '*.config.mjs',
            'build',
            'dist',
            'admin/words.js',
            'admin/admin.d.ts',
            'admin/blockly.js',
            '**/adapter-config.d.ts',
            'widgets/**/*.js'
        ],
    },
    {
        rules: {
            // Every function, method and class here carries real JSDoc, and
            // that stays required. What is switched off is the demand for a
            // block on each *member* of an interface or type union: `--fix`
            // answers it by inserting empty blocks, which then fail
            // `jsdoc/no-blank-blocks`, and the honest fix is worse than the
            // warning. The model's members are documented in prose where the
            // reasoning is not obvious, and left bare where it is.
            'jsdoc/require-jsdoc': [
                'warn',
                {
                    require: {
                        FunctionDeclaration: true,
                        MethodDefinition: true,
                        ClassDeclaration: true,
                        ArrowFunctionExpression: false,
                        FunctionExpression: false,
                    },
                    contexts: [],
                },
            ],
        },
    },
];