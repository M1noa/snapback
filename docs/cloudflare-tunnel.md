# Cloudflare Tunnel

Discord requires HTTPS for an OAuth redirect URI. A laptop has no certificate, so a tunnel provides one and forwards the public hostname to your local port. `/setup web` prints these steps with a copyable command each.

## The steps

1. Log in and pick the domain:

   ```sh
   cloudflared tunnel login
   ```

2. Create the tunnel:

   ```sh
   cloudflared tunnel create snapback
   ```

3. Write `~/.cloudflared/config.yml` mapping a hostname to the local port. The `tunnel` and `credentials-file` lines come from the `create` command's output; the ingress block is what maps the hostname to `http://localhost:8080`:

   ```yaml
   tunnel: snapback
   credentials-file: <path printed by cloudflared tunnel create>
   ingress:
     - hostname: verify.example.com
       service: http://localhost:8080
     - service: http_status:404
   ```

4. Route DNS for the hostname:

   ```sh
   cloudflared tunnel route dns snapback verify.example.com
   ```

5. Run the tunnel:

   ```sh
   cloudflared tunnel run snapback
   ```

6. Point Snapback at the public URL:

   ```ini
   PUBLIC_BASE_URL=https://verify.example.com
   ```

7. **Tick the Cloudflare tunnel checkbox** in `/setup web`. This sets `BEHIND_CLOUDFLARE_TUNNEL=true`.

## Why HTTPS is required

Discord rejects a non-HTTPS redirect URI. The tunnel is what gives `verify.example.com` a certificate, so the redirect `{PUBLIC_BASE_URL}/callback` is an `https://` URL Discord accepts. Without it, the OAuth authorize request fails with an invalid redirect and the code exchange never runs.

## What the checkbox changes, and why it matters

The checkbox is not cosmetic. With a tunnel in front of the port, every request arrives at Snapback from `127.0.0.1`. The tunnel is the only hop that saw the real client, and the only trustworthy source of the real address is the `CF-Connecting-IP` header Cloudflare sets.

IP capture resolves the address in this order:

1. if `BEHIND_CLOUDFLARE_TUNNEL` is true, use `CF-Connecting-IP`, validated
2. else if `TRUSTED_PROXY_DEPTH` is greater than zero, walk `X-Forwarded-For` right to left and take the first valid address past the proxy hops
3. else use the socket address

With the flag unset behind a tunnel, step 3 runs and the socket address is the loopback. Every captured record then shows `::1`. That silently corrupts the whole record set: every user looks like they came from the same address, and every VPN check looks identical. Get the flag right before you verify anyone.

Capture also validates and normalises the candidate: parseable IPv4 or IPv6, not a private range, not loopback, not link-local, `::ffff:` stripped. If every source is private or loopback it stores the address anyway and flags the record `ip_public = false`, because that is the exact signature of a misconfigured tunnel and it should be visible rather than hidden.

## The loopback probe

After you tick the checkbox, `/setup web` runs a live probe:

1. It tells you to open `{PUBLIC_BASE_URL}/health?probe=1` in a browser on your phone, so the request comes from a real external device.
2. It confirms whether the captured IP looks like a real public address rather than a loopback.

If it sees a loopback address it says: "tunnel mode is on but no `CF-Connecting-IP` arrived; check that the tunnel is actually in front of this port." That means the tunnel is not actually forwarding to the port Snapback listens on, or something else is terminating the request first.

## Quick tunnels

`cloudflared tunnel --url http://localhost:8080` also works and gives you an HTTPS URL with no login. The hostname is random and changes every time you restart the tunnel, which breaks the registered redirect URI on every restart. The wizard says this up front. Use a named tunnel for anything past a one-off test.

## Non-Cloudflare deployments

| Setup | `BEHIND_CLOUDFLARE_TUNNEL` | `TRUSTED_PROXY_DEPTH` | IP source |
|---|---|---|---|
| Cloudflare Tunnel or Cloudflare proxied DNS | `true` | `0` | `CF-Connecting-IP` |
| nginx or Caddy reverse proxy | `false` | `1` | rightmost-minus-N of `X-Forwarded-For` |
| Direct exposure | `false` | `0` | socket address |
| ngrok | `false` | `1` | `X-Forwarded-For` |

`TRUSTED_PROXY_DEPTH` matters. Taking the leftmost `X-Forwarded-For` entry lets any client prepend a fake address. Snapback walks from the right, skips the number of entries you configured, and validates every candidate as a parseable IP before accepting it.
