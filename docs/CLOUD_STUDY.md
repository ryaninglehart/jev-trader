# Free cloud execution of the existing paper study

This is a finite software forward test on standard GitHub-hosted Ubuntu runners in this public repository. It is not a production trading service. No paid runner, Actions artifact, cache extension, hosting subscription or trading API is provisioned.

The collector is archived from commit `098447cb730b6d68416f291d7534e2cf3fe85fac` and runs under Bun 1.4.3 with its unchanged lockfile. Source digest `235a71db4706ae4ef1a909c38e5f0fc630a684ebaac943bb806eb87e1367b081` must match. The original window remains October 16 at 06:17:23 UTC through October 19 at 06:17:23 UTC. All six diagnostic portfolios, the main economic gate and every risk setting remain frozen.

## Handoff and persistence

The preflight branch verifies a read-only copy of the existing journal on Linux, compares complete deterministic replay and risk history, and checks block-pinned public book/fee/trade access. It does not start another collector. Only after preflight passes may the Mac collector be stopped, its PID verified absent, and the final seed copied. Keep the original Mac journal and all prior reports.

`cloud-study-plan.json` identifies the exact encrypted seed, its checksum, original final block and the private draft release. Cloud jobs refuse a missing seed, changed source/configuration, bad input hash chain, missing checkpoint sequence or changed parent block. Restoring means copying the seed journal and appending the exact original body/digest rows; it never substitutes a new study.

The cloud supervisor alone receives the Actions token and checkpoint encryption key. Its collector subprocess receives only PATH and DRY_RUN=true, runs with --no-env-file, and imports no wallet, signer, Jev or live submission adapter. Checkpoints use AES-256-GCM with independent nonces. The recovery key stays in a local ignored file with owner-only permissions and a protected repository Actions secret. Do not print it, commit it or put it in command arguments.

Encrypted append-only checkpoint segments are stored in an unpublished draft release, avoiding Actions artifact storage charges. The first cloud checkpoint is made after one minute, then approximately every fifteen minutes and at each orderly stop. Each upload is read back and checked. Earlier segments remain intact. No raw journal, simulated report or decryption key is published to the repository or dashboard host.

GitHub jobs have a six-hour maximum. Sixteen sequential segments allow up to 4.5 collector hours each, with time reserved for setup, replay and checkpoint transfer. There is one concurrency group and one matrix worker. Each segment restores every earlier checkpoint, verifies replay, and resumes the same journal. There may be queues and handoff delays; the original collector backfills every missing market block. Completion ends collection and later segments become no-ops. A collector/data failure stops automatic continuation for investigation. No strategy is promoted.

## Limits and monitoring

Free hosted runners have no uptime guarantee. An abrupt runner loss can require recovering the latest durable checkpoint and fetching subsequent canonical blocks again; unavailable historical state is a blocker. Never describe this as guaranteed uninterrupted observation. The Mac copy remains a recovery baseline, not a second writer.

The local chat heartbeat must inspect the cloud workflow and decrypt the latest checkpoint report once migration is active; it must not restart the retired Mac collector. Full restoration/replay is required for completion and after integrity concerns. Dashboard publication still uses the owner-private Sites workflow and saved snapshots; cloud collection continues independently while the Mac sleeps. Chat follow-ups and dashboard publication may wait until the app is available.

GitHub documents standard hosted runners as free in public repositories and release assets as having no aggregate storage or bandwidth quota. The checked workflow uses no larger runners or billable artifact storage. Do not change the repository to private, raise a cache allowance, add a paid runner, publish the draft release, reset a journal or alter the frozen window as part of routine recovery.
