import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(
  path.join(repoRoot, 'src', 'features', 'authFiles', 'statusFailureHistory.ts'),
  'utf8'
);
const moduleSource = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const history = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`
);

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
    this.setCount = 0;
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.setCount += 1;
    this.values.set(key, value);
  }
}

const hour = 60 * 60 * 1000;
const bucketStart = new Date(2026, 6, 15, 1, 20, 0, 0).getTime();
const bucket = {
  startTime: bucketStart,
  endTime: bucketStart + 10 * 60 * 1000,
};
const observedAt = bucketStart + 3 * 60 * 1000;
const detailsFor = (store, fileName, targetBucket, now) =>
  history.getStatusFailureDetailsForBlock(
    history.getStatusFailureBucketsForFile(store, fileName, now),
    targetBucket,
    now
  );

let store = history.createEmptyStatusFailureHistory();
store = history.recordStatusFailure(store, {
  fileName: 'Account-A.json',
  bucket,
  category: 'connection_transient',
  message: 'unexpected EOF refresh_token=rt-secret-abcdef123456',
  observedAt,
});

const memoryStorage = new MemoryStorage();
assert.equal(history.writeStatusFailureHistory(memoryStorage, store), true);
assert.equal(memoryStorage.setCount, 1);
assert.equal(
  history.writeStatusFailureHistory(memoryStorage, store),
  true,
  'Writing an unchanged snapshot should remain a successful no-op.'
);
assert.equal(memoryStorage.setCount, 1, 'Ten-second polling must not rewrite identical history.');

const beforeExpiry = history.readStatusFailureHistory(
  memoryStorage,
  observedAt + history.STATUS_FAILURE_HISTORY_TTL_MS - 1
);
const persistedDetails = detailsFor(
  beforeExpiry,
  'account-a.json',
  bucket,
  observedAt + history.STATUS_FAILURE_HISTORY_TTL_MS - 1
);
assert.equal(
  persistedDetails.length,
  1,
  'A captured reason must survive a page reload for three hours.'
);
assert.equal(persistedDetails[0].category, 'connection_transient');
assert.equal(persistedDetails[0].message, 'unexpected EOF');

const atExpiry = history.readStatusFailureHistory(
  memoryStorage,
  observedAt + history.STATUS_FAILURE_HISTORY_TTL_MS
);
assert.deepEqual(
  detailsFor(
    atExpiry,
    'account-a.json',
    bucket,
    observedAt + history.STATUS_FAILURE_HISTORY_TTL_MS
  ),
  [],
  'A reason must disappear exactly when its three-hour retention ends.'
);

const sameReasonSeenAgain = history.recordStatusFailure(store, {
  fileName: 'account-a.json',
  bucket,
  category: 'connection_transient',
  message: 'unexpected EOF refresh_token=another-secret',
  observedAt: observedAt + 10_000,
});
const repeatedDetails = detailsFor(
  sameReasonSeenAgain,
  'account-a.json',
  bucket,
  observedAt + 10_000
);
assert.equal(repeatedDetails[0].observedAt, observedAt);
assert.equal(
  repeatedDetails[0].expiresAt,
  observedAt + history.STATUS_FAILURE_HISTORY_TTL_MS,
  'Polling the same reason must not keep extending its lifetime.'
);

const nextBucket = {
  startTime: bucket.startTime + 10 * 60 * 1000,
  endTime: bucket.endTime + 10 * 60 * 1000,
};
const unchangedReasonInNextBucket = history.recordStatusFailure(sameReasonSeenAgain, {
  fileName: 'account-a.json',
  bucket: nextBucket,
  category: 'connection_transient',
  message: 'unexpected EOF',
  observedAt: observedAt + 11 * 60 * 1000,
});
const unchangedReasonNextBucketDetails = detailsFor(
  unchangedReasonInNextBucket,
  'account-a.json',
  nextBucket,
  observedAt + 11 * 60 * 1000
);
assert.equal(
  unchangedReasonNextBucketDetails.length,
  1,
  'A continuing failure must be attached to every exact ten-minute bucket that counted it.'
);
assert.equal(unchangedReasonNextBucketDetails[0].category, 'connection_transient');
assert.equal(unchangedReasonNextBucketDetails[0].message, 'unexpected EOF');
assert.equal(unchangedReasonNextBucketDetails[0].observedAt, observedAt + 11 * 60 * 1000);
assert.equal(
  unchangedReasonNextBucketDetails[0].expiresAt,
  observedAt + 11 * 60 * 1000 + history.STATUS_FAILURE_HISTORY_TTL_MS
);
const clearedEpisode = history.clearActiveStatusFailure(
  unchangedReasonInNextBucket,
  'account-a.json',
  observedAt + 11 * 60 * 1000
);
const recapturedAfterHealthy = history.recordStatusFailure(clearedEpisode, {
  fileName: 'account-a.json',
  bucket: nextBucket,
  category: 'connection_transient',
  message: 'unexpected EOF',
  observedAt: observedAt + 11 * 60 * 1000,
});
assert.equal(
  detailsFor(recapturedAfterHealthy, 'account-a.json', nextBucket, observedAt + 11 * 60 * 1000)
    .length,
  1,
  'The same reason may bind to a new bucket only after a healthy state clears the episode.'
);
const sameBucketFirstEpisode = history.recordStatusFailure(
  history.createEmptyStatusFailureHistory(),
  {
    fileName: 'same-bucket.json',
    bucket,
    category: 'connection_transient',
    message: 'EOF',
    observedAt,
  }
);
const sameBucketCleared = history.clearActiveStatusFailure(
  sameBucketFirstEpisode,
  'same-bucket.json',
  observedAt + 60_000
);
const sameBucketSecondEpisode = history.recordStatusFailure(sameBucketCleared, {
  fileName: 'same-bucket.json',
  bucket,
  category: 'connection_transient',
  message: 'EOF',
  observedAt: observedAt + 120_000,
});
const sameBucketSecondDetails = detailsFor(
  sameBucketSecondEpisode,
  'same-bucket.json',
  bucket,
  observedAt + 120_000
);
assert.equal(sameBucketSecondDetails[0].observedAt, observedAt + 120_000);
assert.equal(
  sameBucketSecondDetails[0].expiresAt,
  observedAt + 120_000 + history.STATUS_FAILURE_HISTORY_TTL_MS,
  'A recovered then repeated reason in the same bucket must start a fresh three-hour detail lifetime.'
);

let multiCategory = history.recordStatusFailure(sameReasonSeenAgain, {
  fileName: 'account-a.json',
  bucket,
  category: 'upstream_access_blocked',
  message: 'cloudflare challenge',
  observedAt: observedAt + 20_000,
});
multiCategory = history.recordStatusFailure(multiCategory, {
  fileName: 'account-b.json',
  bucket: {
    ...bucket,
    startTime: bucket.startTime + 10 * 60 * 1000,
    endTime: bucket.endTime + 10 * 60 * 1000,
  },
  category: 'rate_limited',
  message: 'quota exceeded',
  observedAt: observedAt + 30_000,
});
assert.deepEqual(
  detailsFor(multiCategory, 'account-a.json', bucket, observedAt + 30_000)
    .map((detail) => detail.category)
    .sort(),
  ['connection_transient', 'upstream_access_blocked'],
  'Different categories observed in one bucket must both remain available.'
);
assert.deepEqual(
  detailsFor(multiCategory, 'account-b.json', bucket, observedAt + 30_000),
  [],
  'Accounts and request buckets must never share reasons.'
);
assert.equal(
  detailsFor(
    multiCategory,
    'account-b.json',
    {
      ...bucket,
      startTime: bucket.startTime + 10 * 60 * 1000,
      endTime: bucket.endTime + 10 * 60 * 1000,
    },
    observedAt + 30_000
  ).length,
  1,
  'The second account fixture must actually be stored in its own bucket.'
);
assert.equal(
  detailsFor(multiCategory, 'account-a.json', nextBucket, observedAt + 30_000).length,
  0,
  'A store that never observed the next bucket must not invent a reason for it.'
);

const serialized = history.serializeStatusFailureHistory(multiCategory);
assert.doesNotMatch(serialized, /rt-secret|another-secret|refresh_token/i);
assert.match(serialized, /unexpected EOF/);

let privacyStore = history.createEmptyStatusFailureHistory();
for (const [index, message] of [
  'Cookie: BXAuth=secret-cookie-123456',
  'session=secret-session-123456',
  'Authorization: Basic dXNlcjpwYXNz',
  'https://user:password@example.com/path?token=secret-query-123456',
  'Cookie: first=secret-one; BXAuth=secret-two; session_token=secret-three',
  'socks5://proxy-user:proxy-password@127.0.0.1:1080 connection refused',
].entries()) {
  privacyStore = history.recordStatusFailure(privacyStore, {
    fileName: `privacy-${index}.json`,
    bucket: {
      ...bucket,
      startTime: bucket.startTime + index * 60_000,
      endTime: bucket.endTime + index * 60_000,
    },
    category: 'unknown_upstream_error',
    message,
    observedAt: observedAt + index,
  });
}
const privacySerialized = history.serializeStatusFailureHistory(privacyStore);
assert.doesNotMatch(
  privacySerialized,
  /secret-cookie|secret-session|dXNlcjpwYXNz|user:password|secret-query|secret-one|secret-two|secret-three|proxy-user|proxy-password/i,
  'Cookie, session, Basic auth, URL credentials, and generic token values must never persist.'
);

const unknownFreeText = 'provider internal diagnostic payload account-742';
assert.equal(
  history.simplifyStatusFailureMessage('unknown_upstream_error', unknownFreeText),
  '',
  'Unknown upstream free text must fail closed instead of relying on incomplete redaction.'
);
const unknownFreeTextStore = history.recordStatusFailure(
  history.createEmptyStatusFailureHistory(),
  {
    fileName: 'unknown-free-text.json',
    bucket,
    category: 'unknown_upstream_error',
    message: unknownFreeText,
    observedAt,
  }
);
const [unknownFreeTextDetail] = detailsFor(
  unknownFreeTextStore,
  'unknown-free-text.json',
  bucket,
  observedAt
);
assert.equal(unknownFreeTextDetail.category, 'unknown_upstream_error');
assert.equal(
  unknownFreeTextDetail.message,
  '',
  'Unknown evidence must keep its category so the tooltip does not fall back to reason unavailable.'
);
assert.doesNotMatch(
  history.serializeStatusFailureHistory(unknownFreeTextStore),
  /provider internal diagnostic|account-742/i,
  'Unknown upstream free text must never be persisted in the three-hour history.'
);

const allowlistedMessageCases = [
  {
    category: 'connection_transient',
    raw: 'ECONNRESET while contacting Alice at C:/Users/Alice/private.txt',
    expected: 'connection reset',
  },
  {
    category: 'request_interrupted',
    raw: 'context canceled for Alice at C:/Users/Alice/private.txt',
    expected: 'context canceled',
  },
  {
    category: 'upstream_service_error',
    raw: 'HTTP 503 - Alice C:/Users/Alice/private.txt',
    expected: 'HTTP 503',
  },
  {
    category: 'credential_invalid',
    raw: 'invalid token for Alice at C:/Users/Alice/private.txt',
    expected: 'credential invalid',
  },
  {
    category: 'rate_limited',
    raw: 'quota exceeded for Alice at C:/Users/Alice/private.txt',
    expected: 'rate limited',
  },
];
let allowlistedStore = history.createEmptyStatusFailureHistory();
allowlistedMessageCases.forEach(({ category, raw, expected }, index) => {
  assert.equal(
    history.simplifyStatusFailureMessage(category, raw),
    expected,
    `${category} must persist only an allowlisted short reason.`
  );
  allowlistedStore = history.recordStatusFailure(allowlistedStore, {
    fileName: `allowlisted-${index}.json`,
    bucket,
    category,
    message: raw,
    observedAt: observedAt + index,
  });
});
assert.doesNotMatch(
  history.serializeStatusFailureHistory(allowlistedStore),
  /Alice|private\.txt|C:\/Users/i,
  'Known categories must not persist arbitrary names, paths, or explanatory suffixes.'
);

const midnightBucket = {
  startTime: new Date(2026, 6, 14, 23, 50, 0, 0).getTime(),
  endTime: new Date(2026, 6, 15, 0, 0, 0, 0).getTime(),
};
const midnightStore = history.recordStatusFailure(history.createEmptyStatusFailureHistory(), {
  fileName: 'midnight.json',
  bucket: midnightBucket,
  category: 'request_interrupted',
  message: 'context canceled',
  observedAt: new Date(2026, 6, 15, 0, 1, 0, 0).getTime(),
});
assert.equal(
  detailsFor(
    midnightStore,
    'midnight.json',
    midnightBucket,
    new Date(2026, 6, 15, 0, 2, 0, 0).getTime()
  ).length,
  1,
  'A bucket that crosses midnight must keep its exact local-day identity.'
);

assert.equal(
  history.findLatestCapturableFailureBlock(
    [{ success: 0, failure: 1, rate: 0, ...bucket }],
    bucket.endTime + history.STATUS_FAILURE_CAPTURE_MAX_AGE_MS
  )?.index,
  0
);
assert.equal(
  history.findLatestCapturableFailureBlock(
    [{ success: 0, failure: 1, rate: 0, ...bucket }],
    bucket.endTime + history.STATUS_FAILURE_CAPTURE_MAX_AGE_MS + 1
  ),
  null,
  'A current status message must not be attached to a failure bucket older than ten minutes.'
);
assert.equal(
  history.findLatestCapturableFailureBlock(
    [
      { success: 0, failure: 1, rate: 0, ...bucket },
      { success: 1, failure: 0, rate: 1, ...nextBucket },
    ],
    nextBucket.endTime
  ),
  null,
  'A later successful bucket must stop a stale status message from being reattached after recovery.'
);
assert.equal(
  history.hasLatestSuccessfulRequestBlock([
    { success: 0, failure: 1, rate: 0, ...bucket },
    { success: 1, failure: 0, rate: 1, ...nextBucket },
  ]),
  true,
  'The capture layer must expose a recovery signal so the active episode can be cleared.'
);

assert.deepEqual(
  history.readStatusFailureHistory(
    new MemoryStorage({ [history.STATUS_FAILURE_HISTORY_STORAGE_KEY]: '{bad json' }),
    observedAt
  ),
  history.createEmptyStatusFailureHistory(),
  'Broken localStorage data must fail soft.'
);
assert.deepEqual(
  history.readStatusFailureHistory(
    new MemoryStorage({
      [history.STATUS_FAILURE_HISTORY_STORAGE_KEY]: JSON.stringify({ version: 99, files: {} }),
    }),
    observedAt
  ),
  history.createEmptyStatusFailureHistory(),
  'Unknown storage versions must fail soft.'
);

const legacySensitiveFingerprintPayload = {
  version: 1,
  files: {},
  active: {
    'legacy-known.json': {
      fingerprint: JSON.stringify([
        'credential_invalid',
        'invalid token for Alice at C:/Users/Alice/private.txt',
      ]),
      bucketStartTime: bucket.startTime,
      observedAt,
      expiresAt: observedAt + history.STATUS_FAILURE_HISTORY_TTL_MS,
    },
    'legacy-unknown.json': {
      fingerprint: JSON.stringify([
        'unknown_upstream_error',
        'provider note for Bob at C:/Users/Bob/private.txt',
      ]),
      bucketStartTime: bucket.startTime,
      observedAt,
      expiresAt: observedAt + history.STATUS_FAILURE_HISTORY_TTL_MS,
    },
    'legacy-malformed.json': {
      fingerprint: 'raw note for Carol at C:/Users/Carol/private.txt',
      bucketStartTime: bucket.startTime,
      observedAt,
      expiresAt: observedAt + history.STATUS_FAILURE_HISTORY_TTL_MS,
    },
  },
};
const legacySensitiveFingerprintStore = history.parseStatusFailureHistory(
  JSON.stringify(legacySensitiveFingerprintPayload),
  observedAt + 1
);
assert.equal(
  legacySensitiveFingerprintStore.active['legacy-known.json'].fingerprint,
  JSON.stringify(['browser', 'credential_invalid', 'credential invalid'])
);
assert.equal(
  legacySensitiveFingerprintStore.active['legacy-unknown.json'].fingerprint,
  JSON.stringify(['browser', 'unknown_upstream_error', ''])
);
assert.equal(
  legacySensitiveFingerprintStore.active['legacy-malformed.json'].fingerprint,
  null,
  'An unverifiable legacy fingerprint must become a cleared episode.'
);
assert.doesNotMatch(
  history.serializeStatusFailureHistory(legacySensitiveFingerprintStore),
  /Alice|Bob|Carol|private\.txt|C:\/Users/i,
  'Re-serializing legacy active episodes must never preserve arbitrary fingerprint text.'
);
const corruptLifetime = JSON.parse(history.serializeStatusFailureHistory(store));
const corruptFile = corruptLifetime.files['account-a.json'];
const corruptBucket = Object.values(corruptFile)[0];
const corruptDetail = corruptBucket.details.connection_transient;
corruptDetail.expiresAt = corruptDetail.observedAt + 30 * 24 * hour;
const corruptStorage = new MemoryStorage({
  [history.STATUS_FAILURE_HISTORY_STORAGE_KEY]: JSON.stringify(corruptLifetime),
});
assert.deepEqual(
  detailsFor(
    history.readStatusFailureHistory(corruptStorage, corruptDetail.observedAt + 4 * hour),
    'account-a.json',
    bucket,
    corruptDetail.observedAt + 4 * hour
  ),
  [],
  'A damaged v1 expiresAt must never extend a reason beyond observedAt plus three hours.'
);

const leftTab = history.recordStatusFailure(history.createEmptyStatusFailureHistory(), {
  fileName: 'left-tab.json',
  bucket,
  category: 'connection_transient',
  message: 'EOF',
  observedAt,
});
const rightTab = history.recordStatusFailure(history.createEmptyStatusFailureHistory(), {
  fileName: 'right-tab.json',
  bucket,
  category: 'rate_limited',
  message: 'quota exceeded',
  observedAt: observedAt + 1,
});
const mergedTabs = history.mergeStatusFailureHistories(leftTab, rightTab, observedAt + 2);
assert.equal(detailsFor(mergedTabs, 'left-tab.json', bucket, observedAt + 2).length, 1);
assert.equal(detailsFor(mergedTabs, 'right-tab.json', bucket, observedAt + 2).length, 1);
assert.equal(
  history.serializeStatusFailureHistory(
    history.mergeStatusFailureHistories(leftTab, rightTab, observedAt + 2)
  ),
  history.serializeStatusFailureHistory(
    history.mergeStatusFailureHistories(rightTab, leftTab, observedAt + 2)
  ),
  'Cross-tab merges must serialize identically regardless of local insertion order.'
);
const conflictLeft = history.recordStatusFailure(history.createEmptyStatusFailureHistory(), {
  fileName: 'conflict.json',
  bucket,
  category: 'connection_transient',
  message: 'EOF',
  observedAt,
});
const conflictRight = history.recordStatusFailure(history.createEmptyStatusFailureHistory(), {
  fileName: 'conflict.json',
  bucket,
  category: 'connection_transient',
  message: 'connection reset',
  observedAt,
});
assert.equal(
  history.serializeStatusFailureHistory(
    history.mergeStatusFailureHistories(conflictLeft, conflictRight, observedAt + 1)
  ),
  history.serializeStatusFailureHistory(
    history.mergeStatusFailureHistories(conflictRight, conflictLeft, observedAt + 1)
  ),
  'Equal-timestamp cross-tab conflicts must converge deterministically.'
);

const legacyV1Payload = JSON.parse(history.serializeStatusFailureHistory(leftTab));
delete Object.values(legacyV1Payload.files['left-tab.json'])[0].details.connection_transient.source;
const legacyV1Store = history.parseStatusFailureHistory(
  JSON.stringify(legacyV1Payload),
  observedAt + 2
);
assert.equal(
  detailsFor(legacyV1Store, 'left-tab.json', bucket, observedAt + 2)[0].source,
  'browser',
  'Legacy v1 details without an explicit source must default to browser evidence.'
);
const observerEvidence = history.recordStatusFailure(
  history.createEmptyStatusFailureHistory(),
  {
    fileName: 'source-priority.json',
    bucket,
    category: 'connection_transient',
    message: 'unexpected EOF',
    observedAt,
    source: 'observer',
  }
);
const newerBrowserEvidence = history.recordStatusFailure(
  history.createEmptyStatusFailureHistory(),
  {
    fileName: 'source-priority.json',
    bucket,
    category: 'connection_transient',
    message: 'fetch failed',
    observedAt: observedAt + 2 * 60 * 1000,
    source: 'browser',
  }
);
for (const merged of [
  history.mergeStatusFailureHistories(observerEvidence, newerBrowserEvidence, observedAt + 3 * 60 * 1000),
  history.mergeStatusFailureHistories(newerBrowserEvidence, observerEvidence, observedAt + 3 * 60 * 1000),
]) {
  const [detail] = detailsFor(
    merged,
    'source-priority.json',
    bucket,
    observedAt + 3 * 60 * 1000
  );
  assert.equal(detail.source, 'observer');
  assert.equal(
    detail.message,
    'unexpected EOF',
    'Observer evidence must outrank a newer browser status for the same bucket and category.'
  );
}
assert.equal(
  history.writeStatusFailureHistory(
    {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    },
    store
  ),
  false,
  'Storage quota failures must not break the page.'
);

assert.equal(history.STATUS_FAILURE_HISTORY_TTL_MS, 3 * hour);
console.log('auth status failure history cases passed');
