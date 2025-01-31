/* eslint-disable @typescript-eslint/no-unused-vars */
import { formatWithOptions } from "util";
import test, { ExecutionContext } from "ava";
import Redis, { Redis as Client, Cluster } from "ioredis";
import {
  createClient,
  createCluster,
  RedisClusterType,
  RedisClientType,
} from "redis";
import Redlock, { ExecutionError, ResourceLockedError } from "./index.js";

async function fail(
  t: ExecutionContext<unknown>,
  error: unknown
): Promise<void> {
  if (!(error instanceof ExecutionError)) {
    throw error;
  }

  t.fail(`${error.message}
---
${(await Promise.all(error.attempts))
  .map(
    (s, i) =>
      `ATTEMPT ${i}: ${formatWithOptions(
        { colors: true },
        {
          membershipSize: s.membershipSize,
          quorumSize: s.quorumSize,
          votesForSize: s.votesFor.size,
          votesAgainstSize: s.votesAgainst.size,
          votesAgainstError: s.votesAgainst.values(),
        }
      )}`
  )
  .join("\n\n")}
`);
}

function isCluster(a: unknown): a is RedisClusterType {
  if (
    typeof a === "object" &&
    typeof (a as Record<string, unknown>)["getSlotMaster"] === "function"
  )
    return true;
  return false;
}

async function waitForCluster(redis: RedisClusterType): Promise<void> {
  async function checkIsReady(): Promise<boolean> {
    await redis.connect();
    try {
      const res = await redis.sendCommand("INFO", false, ["CLUSTER", "INFO"]);
      return (res as string).match(/^cluster_state:(.+)$/m)?.[1] === "ok";
    } catch (e) {
      console.warn(e);
      return true;
    }
  }

  let isReady = await checkIsReady();
  while (!isReady) {
    console.log("Waiting for cluster to be ready...");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    isReady = await checkIsReady();
  }

  async function checkIsWritable(): Promise<boolean> {
    try {
      return ((await redis.set("isWritable", "true")) as string) === "OK";
    } catch (error) {
      console.error(`Cluster unable to receive writes: ${error}`);
      return false;
    }
  }

  let isWritable = await checkIsWritable();
  while (!isWritable) {
    console.log("Waiting for cluster to be writable...");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    isWritable = await checkIsWritable();
  }
}

function run(
  namespace: string,
  redis: RedisClientType | RedisClusterType
): void {
  test.before(async () => {
    try {
      if (namespace === "cluster" && isCluster(redis)) {
        await waitForCluster(redis);
      } else {
        await redis.connect();
      }
    } catch (e) {
      // do nothing
    }
  });

  test.before(async () => {
    if (isCluster(redis)) {
      try {
        await waitForCluster(redis);
        const nodes = (await redis.sendCommand("CLUSTER", false, [
          "CLUSTER",
          "NODES",
        ])) as string;

        const slots = nodes
          ?.split("\n")
          .map((x) => {
            const trimmed = x.trim();

            const [
              id,
              url,
              flags,
              master,
              pingStart,
              pingEnd,
              configEpoc,
              linkState,
              slots,
            ] = trimmed.split(" ");

            if (slots) {
              return parseInt(slots.split("-")[0]);
            }
            return null;
          })
          .filter((x) => x !== null) as number[];

        for (const slot of slots) {
          // console.log(`deleting slot ${i}`);
          await (await redis.slots[slot].master.client)?.flushAll()
        }
      } catch (e) {
        console.log({ e });
        //do noting
      }
    } else {
      if (!redis.isOpen) {
        await redis.connect();
      }
      await (redis as RedisClientType).flushAll();
    }
  });

  test(`${namespace} - refuses to use a non-integer duration`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = Number.MAX_SAFE_INTEGER / 10;

      // Acquire a lock.
      await redlock.acquire(["{redlock}float"], duration);

      t.fail("Expected the function to throw.");
    } catch (error) {
      t.is(
        (error as Error).message,
        "Duration must be an integer value in milliseconds."
      );
    }
  });
  // return;

  test(`${namespace} - acquires, extends, and releases a single lock`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

      // Acquire a lock.
      let lock = await redlock.acquire(["{redlock}a"], duration);
      t.is(
        await redis.get("{redlock}a"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.floor((await redis.pTTL("{redlock}a")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Extend the lock.
      lock = await lock.extend(3 * duration);
      t.is(
        await redis.get("{redlock}a"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.floor((await redis.pTTL("{redlock}a")) / 200),
        Math.floor((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Release the lock.
      await lock.release();
      t.is(await redis.get("{redlock}a"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - acquires, extends, and releases a multi-resource lock`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

      // Acquire a lock.
      let lock = await redlock.acquire(
        ["{redlock}a1", "{redlock}a2"],
        duration
      );
      t.is(
        await redis.get("{redlock}a1"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redis.get("{redlock}a2"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.floor((await redis.pTTL("{redlock}a1")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.floor((await redis.pTTL("{redlock}a2")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Extend the lock.
      lock = await lock.extend(3 * duration);
      t.is(
        await redis.get("{redlock}a1"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redis.get("{redlock}a2"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.floor((await redis.pTTL("{redlock}a1")) / 200),
        Math.floor((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.floor((await redis.pTTL("{redlock}a2")) / 200),
        Math.floor((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Release the lock.
      await lock.release();
      t.is(await redis.get("{redlock}a1"), null);
      t.is(await redis.get("{redlock}a2"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - locks fail when redis is unreachable`, async (t) => {
    try {
      const redis = new Redis({
        host: "127.0.0.1",
        maxRetriesPerRequest: 0,
        autoResendUnfulfilledCommands: false,
        autoResubscribe: false,
        retryStrategy: () => null,
        reconnectOnError: () => false,
      });

      redis.on("error", () => {
        // ignore redis-generated errors
      });

      const redlock = new Redlock([redis]);

      const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);
      try {
        await redlock.acquire(["{redlock}b"], duration);
        throw new Error("This lock should not be acquired.");
      } catch (error) {
        if (!(error instanceof ExecutionError)) {
          throw error;
        }

        t.is(
          error.attempts.length,
          11,
          "A failed acquisition must have the configured number of retries."
        );

        for (const e of await Promise.allSettled(error.attempts)) {
          t.is(e.status, "fulfilled");
          if (e.status === "fulfilled") {
            for (const v of e.value?.votesAgainst?.values()) {
              t.is(v.message, "Connection is closed.");
            }
          }
        }
      }
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - locks automatically expire`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 200;

      // Acquire a lock.
      const lock = await redlock.acquire(["{redlock}d"], duration);
      t.is(
        await redis.get("{redlock}d"),
        lock.value,
        "The lock value was incorrect."
      );

      // Wait until the lock expires.
      await new Promise((resolve) => setTimeout(resolve, 300, undefined));

      // Attempt to acquire another lock on the same resource.
      const lock2 = await redlock.acquire(["{redlock}d"], duration);
      t.is(
        await redis.get("{redlock}d"),
        lock2.value,
        "The lock value was incorrect."
      );

      // Release the lock.
      await lock2.release();
      t.is(await redis.get("{redlock}d"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - individual locks are exclusive`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

      // Acquire a lock.
      const lock = await redlock.acquire(["{redlock}c"], duration);
      t.is(
        await redis.get("{redlock}c"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.floor((await redis.pTTL("{redlock}c")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Attempt to acquire another lock on the same resource.
      try {
        await redlock.acquire(["{redlock}c"], duration);
        throw new Error("This lock should not be acquired.");
      } catch (error) {
        if (!(error instanceof ExecutionError)) {
          throw error;
        }

        t.is(
          error.attempts.length,
          11,
          "A failed acquisition must have the configured number of retries."
        );

        for (const e of await Promise.allSettled(error.attempts)) {
          t.is(e.status, "fulfilled");
          if (e.status === "fulfilled") {
            for (const v of e.value?.votesAgainst?.values()) {
              t.assert(
                v instanceof ResourceLockedError,
                "The error must be a ResourceLockedError."
              );
            }
          }
        }
      }

      // Release the lock.
      await lock.release();
      t.is(await redis.get("{redlock}c"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - overlapping multi-locks are exclusive`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

      // Acquire a lock.
      const lock = await redlock.acquire(
        ["{redlock}c1", "{redlock}c2"],
        duration
      );
      t.is(
        await redis.get("{redlock}c1"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redis.get("{redlock}c2"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.floor((await redis.pTTL("{redlock}c1")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.floor((await redis.pTTL("{redlock}c2")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Attempt to acquire another lock with overlapping resources
      try {
        await redlock.acquire(["{redlock}c2", "{redlock}c3"], duration);
        throw new Error("This lock should not be acquired.");
      } catch (error) {
        if (!(error instanceof ExecutionError)) {
          throw error;
        }

        t.is(
          await redis.get("{redlock}c1"),
          lock.value,
          "The original lock value must not be changed."
        );
        t.is(
          await redis.get("{redlock}c2"),
          lock.value,
          "The original lock value must not be changed."
        );
        t.is(
          await redis.get("{redlock}c3"),
          null,
          "The new resource must remain unlocked."
        );

        t.is(
          error.attempts.length,
          11,
          "A failed acquisition must have the configured number of retries."
        );

        for (const e of await Promise.allSettled(error.attempts)) {
          t.is(e.status, "fulfilled");
          if (e.status === "fulfilled") {
            for (const v of e.value?.votesAgainst?.values()) {
              t.assert(
                v instanceof ResourceLockedError,
                "The error must be a ResourceLockedError."
              );
            }
          }
        }
      }

      // Release the lock.
      await lock.release();
      t.is(await redis.get("{redlock}c1"), null);
      t.is(await redis.get("{redlock}c2"), null);
      t.is(await redis.get("{redlock}c3"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - the \`using\` helper acquires, extends, and releases locks`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 500;

      const valueP: Promise<string | null> = redlock.using(
        ["{redlock}x"],
        duration,
        {
          automaticExtensionThreshold: 200,
        },
        async (signal) => {
          const lockValue = await redis.get("{redlock}x");
          t.assert(
            typeof lockValue === "string",
            "The lock value was not correctly acquired."
          );

          // Wait to ensure that the lock is extended
          await new Promise((resolve) => setTimeout(resolve, 700, undefined));

          t.is(signal.aborted, false, "The signal must not be aborted.");
          t.is(signal.error, undefined, "The signal must not have an error.");

          t.is(
            await redis.get("{redlock}x"),
            lockValue,
            "The lock value should not have changed."
          );

          return lockValue;
        }
      );

      await valueP;

      t.is(await redis.get("{redlock}x"), null, "The lock was not released.");
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - the \`using\` helper is exclusive`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 500;

      let locked = false;
      const [lock1, lock2] = await Promise.all([
        await redlock.using(
          ["{redlock}y"],
          duration,
          {
            automaticExtensionThreshold: 200,
          },
          async (signal) => {
            t.is(locked, false, "The resource must not already be locked.");
            locked = true;

            const lockValue = await redis.get("{redlock}y");
            t.assert(
              typeof lockValue === "string",
              "The lock value was not correctly acquired."
            );

            // Wait to ensure that the lock is extended
            await new Promise((resolve) => setTimeout(resolve, 700, undefined));

            t.is(signal.error, undefined, "The signal must not have an error.");
            t.is(signal.aborted, false, "The signal must not be aborted.");

            t.is(
              await redis.get("{redlock}y"),
              lockValue,
              "The lock value should not have changed."
            );

            locked = false;
            return lockValue;
          }
        ),
        await redlock.using(
          ["{redlock}y"],
          duration,
          {
            automaticExtensionThreshold: 200,
          },
          async (signal) => {
            t.is(locked, false, "The resource must not already be locked.");
            locked = true;

            const lockValue = await redis.get("{redlock}y");
            t.assert(
              typeof lockValue === "string",
              "The lock value was not correctly acquired."
            );

            // Wait to ensure that the lock is extended
            await new Promise((resolve) => setTimeout(resolve, 700, undefined));

            t.is(signal.error, undefined, "The signal must not have an error.");
            t.is(signal.aborted, false, "The signal must not be aborted.");

            t.is(
              await redis.get("{redlock}y"),
              lockValue,
              "The lock value should not have changed."
            );

            locked = false;
            return lockValue;
          }
        ),
      ]);

      t.not(lock1, lock2, "The locks must be different.");

      t.is(await redis.get("{redlock}y"), null, "The lock was not released.");
    } catch (error) {
      fail(t, error);
    }
  });
}

run("instance", createClient({ url: "redis://redis-single-instance:6379" }));

run(
  "cluster",
  createCluster({ rootNodes: [{ url: "redis://redis-single-cluster-1:6379" }] })
);
