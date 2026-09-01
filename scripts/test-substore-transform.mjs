import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { subStoreTransformPlugin } from '../vite.substore-transform.js';

const OPEN_API_ID = '/workspace/sub-store/backend/src/vendor/open-api.js';
const DOWNLOAD_ID = '/workspace/sub-store/backend/src/utils/download.js';
const TOKEN_ID = '/workspace/sub-store/backend/src/restful/token.js';
const RUNTIME_ID = '/workspace/sub-store/backend/src/runtime';

const PLATFORM_FIXTURE = `import { ENV } from '@/vendor/open-api';

export function tryNodeBuiltin(load) {
    if (!ENV().isNode) return undefined;

    try {
        return load();
    } catch (e) {
        return undefined;
    }
}
`;

function transformFixture(source, id) {
    const plugin = subStoreTransformPlugin();
    const result = plugin.transform.call({
        error(message) {
            throw new Error(String(message));
        },
    }, source, id);
    return result?.code ?? source;
}

function loadRuntimeGetter(moduleName, globals) {
    const getter = transformFixture(`import { tryNodeBuiltin } from './platform';

export default function getBuiltin() {
    return tryNodeBuiltin(() => require('${moduleName}'));
}
`, `${RUNTIME_ID}/builtin.js`);
    const platform = transformFixture(PLATFORM_FIXTURE, `${RUNTIME_ID}/platform.js`);

    return runInNewContext(`(() => {
${platform.replace("import { ENV } from '@/vendor/open-api';", 'const ENV = () => ({ isNode: globalThis.isNode });').replace('export function', 'function')}
${getter.replace("import { tryNodeBuiltin } from './platform';", '').replace('export default function', 'function')}
return getBuiltin;
})();
`, globals);
}

const DOWNLOAD_FIXTURE = `function hex_md5(value) {
    return String(value);
}

const tasks = new Map();
let implementationCalls = 0;

export function getImplementationCalls() {
    return implementationCalls;
}

export default async function download(
    rawUrl = '',
    ua,
    timeout,
    customProxy,
    skipCustomCache,
    awaitCustomCache,
    noCache,
    preprocess,
    options = {},
) {
    implementationCalls += 1;
    const id = hex_md5(rawUrl);
    if (tasks.has(id)) return tasks.get(id);
    const rawResult = {
        rawUrl,
        timeout,
        customProxy,
        skipCustomCache,
        awaitCustomCache,
        preprocess,
        options,
    };
    tasks.set(id, rawResult);
    return rawResult;
}

export async function downloadFile(url, file) {
    return { url, file };
}
`;

function openApiFixture(isSurgeDeclaration) {
    return `const isLoon = typeof $loon !== 'undefined';
const isEgern = 'undefined' !== typeof Egern;
${isSurgeDeclaration}
const isNode = eval(\`typeof process !== "undefined"\`);

export class OpenAPI {
    constructor() {
        this.name = 'sub-store';
        this.cache = JSON.parse($persistentStore.read(this.name) || '{}');
    }

    save() {
        const data = JSON.stringify(this.cache, null, 2);
        return data;
    }

    set(key, data) {
        this.cache[key] = data;
    }

    get(key) {
        return this.cache[key];
    }

    delete(key) {
        delete this.cache[key];
    }
}
`;
}

function transformOpenApi(isSurgeDeclaration) {
    const plugin = subStoreTransformPlugin();
    const context = {
        error(message) {
            throw new Error(String(message));
        },
    };
    const result = plugin.transform.call(context, openApiFixture(isSurgeDeclaration), OPEN_API_ID);
    assert.ok(result, 'expected open-api.js to be transformed');
    return result.code;
}

for (const [name, declaration] of [
    ['legacy declaration', "const isSurge = typeof $httpClient !== 'undefined' && !isLoon;"],
    ['current declaration', "const isSurge = typeof $httpClient !== 'undefined' && !isLoon && !isEgern;"],
    ['future guard declaration', "const isSurge = typeof $httpClient !== 'undefined' && !isLoon && !isEgern && !isMihomo;"],
]) {
    test(`forces isSurge for the ${name}`, () => {
        const output = transformOpenApi(declaration);

        assert.match(output, /const isSurge = true;/);
        assert.doesNotMatch(output, /const\s+isSurge\s*=\s*typeof\s+\$httpClient/);
        assert.match(output, /const isNode = false/);
    });
}

test('requires open-api.js to contain the patched isSurge invariant', () => {
    const plugin = subStoreTransformPlugin();
    const context = {
        error(message) {
            throw new Error(String(message));
        },
    };

    assert.throws(
        () => plugin.transform.call(context, openApiFixture(''), OPEN_API_ID),
        /isSurge 未被固定为 true/,
    );
});

test('download wrapper preserves options across deduplicated calls', () => {
    const plugin = subStoreTransformPlugin();
    const context = {
        error(message) {
            throw new Error(String(message));
        },
    };
    const result = plugin.transform.call(context, DOWNLOAD_FIXTURE, DOWNLOAD_ID);
    assert.ok(result, 'expected download.js to be transformed');

    const output = result.code;
    const forwardingCall = '__download_impl__(rawUrl, ua, timeout, customProxy, skipCustomCache, awaitCustomCache, noCache, preprocess, options)';
    assert.match(output, /export default async function download\([\s\S]*?preprocess,\n    options = \{\},\n\) \{/);
    assert.equal(output.split(forwardingCall).length - 1, 2);
    assert.match(output, /String\(timeout \?\? ''\)/);
    assert.match(output, /String\(customProxy \?\? ''\)/);
    assert.match(output, /Boolean\(skipCustomCache\)/);
    assert.match(output, /Boolean\(awaitCustomCache\)/);
    assert.match(output, /Boolean\(inflightOptions\.returnRaw\)/);
    assert.match(output, /Boolean\(inflightOptions\.noFlow\)/);
    assert.match(output, /inflightOptions\['age-secret-key'\] \|\| inflightOptions\.ageSecretKey/);
    assert.match(output, /hex_md5\(JSON\.stringify\(inflightIdentity\)\)/);
    assert.doesNotMatch(output, /inflightOptions\[AGE_SECRET_KEY\]/);
});

test('download wrapper coalesces only behaviorally equivalent concurrent calls', async () => {
    const plugin = subStoreTransformPlugin();
    const context = {
        error(message) {
            throw new Error(String(message));
        },
    };
    const result = plugin.transform.call(context, DOWNLOAD_FIXTURE, DOWNLOAD_ID);
    assert.ok(result, 'expected download.js to be transformed');

    const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.code).toString('base64')}`;
    const transformed = await import(moduleUrl);
    const previousGetActiveContext = globalThis.__substore_get_active_context__;
    const previousInflightTasks = globalThis.__sub_store_workers_inflight_tasks__;
    globalThis.__substore_get_active_context__ = () => ({ user: { id: 'transform-test-user' } });
    globalThis.__sub_store_workers_inflight_tasks__ = new Map();

    try {
        let before = transformed.getImplementationCalls();
        const equivalent = [
            transformed.default('same-url', 'ua', 1000, 'proxy-a', false, false, false, true, { returnRaw: true }),
            transformed.default('same-url', 'ua', 1000, 'proxy-a', false, false, false, true, { returnRaw: true }),
        ];
        await Promise.all(equivalent);
        assert.equal(transformed.getImplementationCalls() - before, 1);

        before = transformed.getImplementationCalls();
        const differentProxy = [
            transformed.default('proxy-url', 'ua', 1000, 'proxy-a', false, false, false, true, {}),
            transformed.default('proxy-url', 'ua', 1000, 'proxy-b', false, false, false, true, {}),
        ];
        await Promise.all(differentProxy);
        assert.equal(transformed.getImplementationCalls() - before, 2);

        before = transformed.getImplementationCalls();
        const differentOptions = await Promise.all([
            transformed.default('options-url', 'ua', 1000, 'proxy-a', false, false, false, true, { returnRaw: false }),
            transformed.default('options-url', 'ua', 1000, 'proxy-a', false, false, false, true, { returnRaw: true }),
        ]);
        assert.equal(transformed.getImplementationCalls() - before, 2);
        assert.equal(differentOptions[0].options.returnRaw, false);
        assert.equal(differentOptions[1].options.returnRaw, true);
    } finally {
        globalThis.__substore_get_active_context__ = previousGetActiveContext;
        globalThis.__sub_store_workers_inflight_tasks__ = previousInflightTasks;
    }
});

test('nanoid require becomes a namespace import with the upstream API intact', () => {
    const source = `export function createToken() {
    const nanoid = eval(\`require("nanoid")\`);
    return nanoid.customAlphabet(nanoid.urlAlphabet)();
}
`;
    const plugin = subStoreTransformPlugin();
    const context = {
        error(message) {
            throw new Error(String(message));
        },
    };
    const result = plugin.transform.call(context, source, TOKEN_ID);
    assert.ok(result, 'expected token.js to be transformed');

    const output = result.code;
    const importMatch = output.match(
        /import \* as (\w+) from 'nanoid'; \/\/ __SUB_STORE_WORKERS_PATCH__NANOID_NAMESPACE_IMPORT__/,
    );
    assert.ok(importMatch, 'expected a marked nanoid namespace import');
    assert.match(output, new RegExp(`const nanoid = ${importMatch[1]};`));
    assert.match(output, /nanoid\.customAlphabet\(nanoid\.urlAlphabet\)\(\)/);
    assert.doesNotMatch(output, /require\(["']nanoid["']\)/);
});

for (const [moduleName, shimName] of [
    ['path', '__path_shim__'],
    ['fs', '__fs_shim__'],
    ['stream/promises', '__stream_promises_shim__'],
]) {
    test(`runtime ${moduleName} getter preserves the platform gate and lazily loads its shim`, () => {
        const shim = {};
        let reads = 0;
        const globals = { isNode: false };
        Object.defineProperty(globals, shimName, {
            get() {
                reads += 1;
                return shim;
            },
        });
        const getBuiltin = loadRuntimeGetter(moduleName, globals);

        assert.equal(getBuiltin(), undefined);
        assert.equal(reads, 0, 'a non-Node runtime must not invoke the loader');

        globals.isNode = true;
        assert.equal(getBuiltin(), shim);
        assert.equal(reads, 1);
    });
}

test('runtime Node-only transports remain unavailable without invoking require', () => {
    let requireCalls = 0;
    const globals = {
        isNode: true,
        require() {
            requireCalls += 1;
            return { available: true };
        },
    };

    for (const moduleName of ['net', 'tls', 'dgram', 'node:worker_threads']) {
        assert.equal(loadRuntimeGetter(moduleName, globals)(), undefined, moduleName);
    }
    assert.equal(requireCalls, 0);
});

test('direct builtin requires outside the runtime directory still fail closed', () => {
    assert.throws(
        () => transformFixture("export const path = require('path');", '/workspace/sub-store/backend/src/utils/path.js'),
        /仍包含未替换的危险 require\/eval/,
    );
});

test('legacy eval requires outside runtime still use the Workers shim', () => {
    const output = transformFixture("export default eval(`require('fs')`);", TOKEN_ID);
    const shim = {};

    assert.equal(
        runInNewContext(output.replace('export default ', ''), { __fs_shim__: shim }),
        shim,
    );
});

test('buildEnd preserves an existing Rollup failure', () => {
    const plugin = subStoreTransformPlugin();
    let errorCalls = 0;
    const context = {
        error(message) {
            errorCalls += 1;
            throw new Error(String(message));
        },
    };

    plugin.transform.call(
        context,
        'export const loaded = true;',
        '/workspace/sub-store/backend/src/loaded.js',
    );

    assert.doesNotThrow(() => plugin.buildEnd.call(context, new Error('original Rollup failure')));
    assert.equal(errorCalls, 0);
    assert.throws(
        () => plugin.buildEnd.call(context),
        /必需补丁目标未进入构建图：express\.js/,
    );
});
