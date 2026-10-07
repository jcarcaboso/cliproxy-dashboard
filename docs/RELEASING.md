# Releasing and deploying

A release produces a version tag here, an immutable public image on Docker Hub,
a manifest in `releases/<version>.json`, and a digest-pinned update to the
homelab service declaration.

| What | Where |
|---|---|
| Source | `https://github.com/jcarcaboso/cliproxy-dashboard` (`main`, tags `vX.Y.Z`) |
| Image | `docker.io/skorcius/cliproxy-dashboard:<version>`, public, `linux/amd64`, no `latest` |
| Manifest | `releases/<version>.json`: build-input hashes, image and config digests, test counts |
| Deployment | homelab nodes repo (`git@gitlab.com:sk1z0-group/homelab/nodes.git`), `homelab/services/apps-mrb-01_cliproxy-dashboard/` |
| Live URL | `https://cliproxy.mlab.alpetxino.com/usage/` |

Never overwrite a published tag. A broken release is fixed by publishing the
next patch version.

## 1. Prepare the change

```sh
node --run check
node --test test/*.test.js
node test/layout-preview.js   # http://127.0.0.1:8788/, sample data only
```

Check the affected screens in the layout preview at desktop, tablet (~820px)
and phone (390px) widths. Add the new fields to `test/layout-preview.js` when
the change adds UI states, so the preview stays a useful review fixture.
Use `/no-fable/` to check column removal and `/countdown/` to check the
availability refresh after a twelve-second fixture cooldown.

Bump `version` in `package.json`, update the "Published image" section of
`README.md`, then merge to `main` through a pull request.

## 2. Build, test and publish the image

From a clean checkout of the merged `main`:

```sh
VERSION=0.1.8
git status --short   # must be empty

docker build --platform linux/amd64 -t "skorcius/cliproxy-dashboard:$VERSION" .

# The image excludes tests; mount them read-only and run them inside it.
docker run --rm --platform linux/amd64 --read-only --tmpfs /tmp \
  -v "$PWD/test:/app/test:ro" "skorcius/cliproxy-dashboard:$VERSION" node --test test/*.test.js

node scripts/release-manifest.js create "$VERSION" \
  --change "<one-line summary>" --tests <number of passing tests>

docker push "skorcius/cliproxy-dashboard:$VERSION"
digest="$(docker inspect --format '{{index .RepoDigests 0}}' "skorcius/cliproxy-dashboard:$VERSION" | cut -d@ -f2)"
config="$(docker inspect --format '{{.Id}}' "skorcius/cliproxy-dashboard:$VERSION")"
node scripts/release-manifest.js publish "$VERSION" --digest "$digest" --config-digest "$config"
node scripts/release-manifest.js verify "releases/$VERSION.json"
```

Pushing requires a Docker Hub login for the `skorcius` namespace
(`docker login`). Pulling the published image never does.

Commit the manifest, tag and publish:

```sh
git add "releases/$VERSION.json"
git commit -m "release: $VERSION"
git tag "v$VERSION"
git push origin main "v$VERSION"
gh release create "v$VERSION" --title "$VERSION" --notes "<summary> Image: $(jq -r .pinnedImage releases/$VERSION.json)"
```

Confirm anonymous pulls work before deploying, without logging out the publisher:

```sh
anonymous_config="$(mktemp -d)"
docker --config "$anonymous_config" pull "$(jq -r .pinnedImage "releases/$VERSION.json")"
rmdir "$anonymous_config"
```

## 3. Update the homelab declaration

In the homelab nodes checkout (`~/homelab/nodes` on the workstation), change
only `homelab/services/apps-mrb-01_cliproxy-dashboard/`:

- `compose.yml`: set `image:` to the manifest's `pinnedImage`.
- `tests/configuration`: update the expected image to the same value.
- `README.md`: update the image under "Live service" and add a short release note.

```sh
homelab/services/apps-mrb-01_cliproxy-dashboard/tests/configuration
```

That checkout may contain unrelated pending work. Do not commit, revert or
publish changes outside this service directory as part of a dashboard release.

## 4. Deploy (manual, scoped to the dashboard project)

The service uses a manual deployment policy. Until normal GitOps adoption, each
version runs from its own bootstrap directory on `apps-mrb-01`, owned by the
`containers` user, with an `activation.json` receipt next to the Compose file.
Keep earlier bootstrap directories; they are the rollback inputs.

Before recreating the container, check that the reset journal has no pending
operations and record the other containers' IDs and start times. Afterwards,
compare that inventory and confirm the same journal volume is mounted. Do not
use a real provider reset to test a release.

```sh
VERSION=0.1.8
compose=homelab/services/apps-mrb-01_cliproxy-dashboard/compose.yml
dir="/srv/homelab-services/instances/cliproxy-dashboard/bootstrap/$VERSION-$(sha256sum "$compose" | cut -c1-12)"
docker_env='sudo -u containers -H env DOCKER_HOST=unix:///run/user/1002/docker.sock'

ssh apps-mrb-01 "sudo install -d -o containers -g containers -m 0750 '$dir'"
ssh apps-mrb-01 "sudo -u containers tee '$dir/compose.yml' >/dev/null" < "$compose"
ssh apps-mrb-01 "$docker_env docker compose --project-name cliproxy-dashboard -f '$dir/compose.yml' pull"
ssh apps-mrb-01 "$docker_env docker compose --project-name cliproxy-dashboard -f '$dir/compose.yml' up -d"
```

Use the same project name, `cliproxy-dashboard`, every time. That recreates
only the dashboard container and reuses the `cliproxy-dashboard_dashboard-state`
journal volume. Never run `down -v`. Never start a second dashboard project
against the same journal.

Verify, then record the receipt in `$dir/activation.json` in the same shape as
the previous version's receipt:

```sh
curl -fsS https://cliproxy.mlab.alpetxino.com/usage/healthz
curl -fsS https://cliproxy.mlab.alpetxino.com/usage/api/session            # authenticated: false
curl -s -o /dev/null -w '%{http_code}\n' https://cliproxy.mlab.alpetxino.com/usage/api/dashboard   # 401
curl -fsS https://cliproxy.mlab.alpetxino.com/usage/app.js | sha256sum      # matches public/app.js
```

Restarting the container ends existing browser sessions (they are held in
memory), so operators sign in once more after a deploy.

### Rollback

Run `up -d` with the previous bootstrap directory's `compose.yml` and the same
project name. The journal volume is shared across versions and must be kept.
