# Deploying WebHVAC — a simple guide

This guide is written for someone who is new to servers. You do not need to be a
programmer to follow it. Take it one section at a time.

---

## First, what does "deploy" mean here?

WebHVAC is one program. It has two parts:

1. **The pages** (HTML, CSS, JavaScript) — the calculator screen you see in the
   browser, plus the PDF drawing files it can read.
2. **The server** — a small Node.js program (`server.js`) that does one extra job:
   it reads PDF drawings **on the server** instead of inside the browser. This is
   faster, and it works even on phones and slow laptops.

"**Deploy**" simply means: put this program on a computer that is switched on all
the time and connected to the internet, so that you (and anyone you share a link
with) can open it in a browser at a normal web address, like
`https://webhvac.onrender.com`, from anywhere.

Some facts that make this easy:

- There is **no database**. The server keeps nothing and saves nothing. Each
  upload is read in memory and then thrown away.
- There are **no passwords or secret keys** to configure. Nothing to buy.
- Every option below has a **free tier** that is enough for a small test.
- The PDF engine already sits inside the project (in the `vendor/` folder), so the
  server does **not** need to download anything while it runs.

> **Note about GitHub Pages:** GitHub Pages can only serve the **static pages**.
> On Pages, the calculator works fully and PDF reading happens inside your browser
> — but the *server-side* PDF parsing (the faster path) does **not** run there.
> Everything in this guide is about running the server.

---

## (a) Run it on your own PC (simplest — nothing to sign up for)

You need **Node.js 22** installed. Nothing else.

```bash
cd D:/webhvac
npm ci --omit=dev      # downloads the libraries (only the first time)
npm start              # starts the server
```

Now open this in your browser:

```
http://localhost:3000
```

You should see the WebHVAC page. Upload a PDF and it will be read by the server.
To stop the server press **Ctrl + C** in the terminal window.

### Let another device on the same Wi-Fi open it

Your phone or another laptop on the same Wi-Fi can use the app too. Find your PC's
local address, then use it instead of `localhost`.

1. Find your PC's IP address. In git-bash:
   ```bash
   ipconfig | grep -i "IPv4"
   ```
   You will see something like `192.168.1.42`.
2. Make the server listen on all network cards, not just `localhost`:
   ```bash
   HOST=0.0.0.0 npm start
   ```
3. On your phone (same Wi-Fi), open `http://192.168.1.42:3000` (use your own IP).

If it does not open:

- **Windows Firewall** may be blocking Node. When Windows shows the "allow access"
  popup, tick **Private networks** and allow it.
- Make sure both devices are on the **same** Wi-Fi (not one on mobile data).
- This only works at home / office. From the internet you need one of the options
  below.

---

## (b) Run it with Docker on your own PC

Docker packages the program so you do not need to install Node.js yourself.

**Install Docker Desktop first** (free): https://www.docker.com/products/docker-desktop/
Then open Docker Desktop and wait until it says "Engine running".

```bash
cd D:/webhvac
docker compose up -d        # build the image and start it in the background
```

Open:

```
http://localhost:3000
```

Useful commands:

```bash
docker compose logs -f      # watch the live log (Ctrl + C to stop watching)
docker compose down         # stop and remove the container
docker compose up -d --build   # rebuild after you change the code
```

To serve your own drawings, create a folder called `samples` next to
`docker-compose.yml`, put your PDFs in it, then uncomment the two `volumes:` lines
in `docker-compose.yml`. They appear at
`http://localhost:3000/samples/your-file.pdf`.

To change the maximum upload size, edit `MAX_UPLOAD_MB` in `docker-compose.yml`
(50 means 50 MB per file), then run `docker compose up -d` again.

---

## (c) Render (free tier, easiest online option)

Render gives you a real `https://` address for free. The free service goes to
sleep after about 15 minutes with no visitors and wakes up on the next visit, so
the first click after a break is slow (10–30 seconds). That is normal.

The project already contains a `render.yaml` file, so Render can set everything up
by itself. Steps:

1. Go to https://render.com and click **Get Started**. Sign up with your GitHub
   account (free).
2. Click **New +** (top right) and choose **Blueprint**.
3. Connect your GitHub account if asked, then pick the repository
   **`ratul-sraj/hvac`**.
4. Render reads `render.yaml` and shows a summary (one web service named
   `webhvac`, Docker, free plan). Click **Apply**.
5. Wait for the first build. It takes a few minutes — watch the log on screen.
   When it says the service is live, you are done.
6. Your address is shown at the top of the service page, like
   `https://webhvac.onrender.com`. Open it.

To change the maximum PDF size later, open the service in Render, go to
**Environment**, edit `MAX_UPLOAD_MB`, and save. Render will restart the service.

Once this is set up, every time you push new code to the `main` branch on GitHub,
Render rebuilds and redeploys by itself.

---

## (d) Railway (free starter credit, quick)

Railway detects Node.js projects automatically.

1. Go to https://railway.app and sign in with GitHub.
2. **New Project → Deploy from GitHub repo** → choose `ratul-sraj/hvac`.
3. Railway builds with `npm ci` and starts with `npm start` automatically (the
   `start` script already exists in `package.json`).
4. Open **Settings → Networking → Generate Domain** to get your public `https`
   address.
5. Optional: add the variable `MAX_UPLOAD_MB` under **Variables**.

Railway gives a small free credit; after that it needs a paid plan. Fine for a
test.

---

## (e) Fly.io (free allowance, a few commands)

Fly runs your `Dockerfile`. Install **flyctl** first:
https://fly.io/docs/hands-on/install-flyctl/ then run `fly auth login`.

```bash
cd D:/webhvac
fly launch --no-deploy      # creates the app from fly.toml (do NOT let it overwrite the file)
fly deploy                  # builds the image and ships it
fly open                    # opens your live https address
```

The app name in `fly.toml` must be unique across all of Fly. If the name is taken,
`fly launch` picks another one — update the `app = "..."` line in `fly.toml` to
match. To stop spending the free allowance, run `fly apps destroy webhvac`.

---

## (f) Your own server (VPS with Docker)

A "VPS" is a rented computer in a data centre (for example from DigitalOcean,
Hetzner, Contabo or Linode — a small one is a few dollars a month). This gives you
full control and no sleeping.

1. Create the VPS with **Ubuntu** and note its IP address.
2. Log in from your terminal:
   ```bash
   ssh root@YOUR_SERVER_IP
   ```
3. Install Docker (one line):
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
4. Get the code and start it:
   ```bash
   git clone https://github.com/ratul-sraj/hvac.git webhvac
   cd webhvac
   docker compose up -d
   ```
5. Open the firewall port so people can reach it:
   ```bash
   ufw allow 3000/tcp
   ```
   Also open port 3000 in your VPS provider's own firewall/security-group page.
   Now `http://YOUR_SERVER_IP:3000` works.
6. **For a proper `https://` address**, put a small web server in front. The
   easiest is Caddy — on the same machine:
   ```bash
   sudo apt install -y caddy
   ```
   Then point a domain name at your server's IP and create
   `/etc/caddy/Caddyfile` with:
   ```
   your-domain.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```
   Run `sudo systemctl reload caddy`. Caddy fetches the HTTPS certificate for you
   automatically. (Nginx with certbot also works if you prefer it.)

---

## The honest summary

- **GitHub Pages** serves only the static pages. The calculator works there, but
  server-side PDF parsing does not — PDFs are read in the browser instead.
- **No option needs a paid plan** for a small test. Render and Fly have free tiers
  (they sleep when idle); Railway gives free starter credit.
- **There is no database and nothing is stored on the server**, so there is
  nothing to back up. Every uploaded PDF is read in memory and discarded. If you
  need to keep your room data, use the **Export** button in the app.
- Uploads are limited to 10 files per request, `MAX_UPLOAD_MB` (default 25 MB) per
  file. Keep them sensible if your host has little memory — PDF reading happens in
  RAM.
- The load numbers are **handbook-level estimates for early sizing**. An engineer
  must check the input data and the result before using it on a real project.