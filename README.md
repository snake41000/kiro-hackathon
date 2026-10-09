# Kiro Hackathon: Build a Character Voice Agent

In 2 hours, build a web app where a **3D cartoon character** chats with you,
answers in its **own voice** with **lip sync**, shows **emotions**, **moves**,
and has **your** personality.

This repo has **no code**: only the 3D assets and the requirements. You build
the app with **Kiro**. What to build is in **[REQUIREMENTS.md](REQUIREMENTS.md)**.

```
 You type  ──▶  your server  ──▶  Amazon Bedrock (Nova Lite)  ──▶  Amazon Polly  ──▶  the character talks
 (or talk)      (Python)          answer + emotion + move           voice + mouth timings   with lip sync and moves
```

---

## Steps

### 1. Get the repo

```powershell
git clone https://github.com/cloudsoftway/kiro-hackathon.git
cd kiro-hackathon
```

Open the folder in Kiro and build on your laptop. Commit locally as you go
(`git add .`, `git commit -m "..."`), so you can undo mistakes. You'll push to
**your own** GitHub repo only to deploy (step 4).

### 2. Add your AWS key

The organizers send you an access key. Create your `.env`:

```powershell
copy .env.example .env
```

Put your key in `.env`. **Never commit or share it.** It only works for
Amazon Nova Lite, Polly and Transcribe, in us-east-1, during the event.

### 3. Build, milestone by milestone

Ask Kiro to read `REQUIREMENTS.md` and build **one milestone at a time**.
After each one, run the app and check it in the browser before going on.

| # | Milestone | You see |
|---|---|---|
| 1 | **The character appears** | Your 3D character on the page, breathing (idle animation) |
| 2 | **It thinks** | You type a message, it answers in text, in character |
| 3 | **It speaks** | It says the answer out loud, mouth in sync, with a speech bubble |
| 4 | **It feels and moves** | Emotions on its face; "thinking" while waiting, "talking" while speaking; a **Dance** button |
| 5 | **It's yours** | Your own personality, voice, greeting, colors |

Bonuses, once 1–5 work:

| ⭐ | Bonus | You see |
|---|---|---|
| A | **It listens** | Hold a button (or Space), talk, it answers |
| B | **It picks its own moves** | It dances when you ask it to |
| C | **Superpowers** | Tools (dice, quiz score), effects, new Mixamo moves, another avatar |
| D | **It's online** | Your app on your own server (step 4) |

Run your app with `uv run uvicorn main:app --reload` and open
http://localhost:8000.

### 4. Bonus D: put it online

When your app works on your laptop, put it on your own server. The organizers
send you its **instance ID** (`i-...`).

```
your laptop  ──git push──▶  your GitHub repo  ──deploy──▶  your server  ──▶  http://<server-ip>
```

Your app needs `main.py` (with `app = FastAPI()`) and `pyproject.toml` at the
top of the repo, and must work without `.env` (the server has its own AWS
access). **On the server the microphone is off** (plain `http://`): chat by
typing there.

1. **Fork** this repo, once:
   - In the browser: open https://github.com/cloudsoftway/kiro-hackathon, click
     **Fork** (top right), then **Create fork**. Keep it **public**.
   - Or, if you have the [GitHub CLI](https://cli.github.com) (`gh auth login` done):

     ```powershell
     gh repo fork cloudsoftway/kiro-hackathon --remote=false
     ```

   Your fork is `https://github.com/<your-username>/kiro-hackathon`.

2. **Connect** your project folder to your fork, once. In PowerShell, in
   your project folder:

   ```powershell
   git remote add mine https://github.com/<your-username>/kiro-hackathon.git
   git remote -v
   ```

   `git remote -v` must list `mine` with **your** username. (`origin` is the
   original repo: you can't push there.)

3. **Push** your work to your fork:

   ```powershell
   git add .
   git status
   git commit -m "My character"
   git push mine HEAD:main
   ```

   Check that `git status` does **not** list `.env` before you commit (it's in
   `.gitignore`, so it shouldn't). The first push may open a browser window to
   sign in to GitHub. If GitHub says your fork already has commits, use
   `git push --force mine HEAD:main` (it replaces what's in **your** fork only).

4. Once: `aws configure` with the **same key as your `.env`**, region
   **us-east-1**, output **json**.
5. Open a terminal on your server: `aws ssm start-session --target i-0123456789abcdef0`
6. In that terminal:

   ```
   deploy https://github.com/<your-username>/kiro-hackathon
   ```

   It downloads your code, installs the packages, starts the app and prints
   your URL, or the error if the app fails. `logs` shows the app's output
   (Ctrl+C to stop). `exit` to leave.

After each change: step 3 (add, commit, push), then steps 5 and 6 again.

---

## Rules

- Solo: one person, one character. Built during the event, with Kiro.
- Only the AWS services your key allows. **Never share your `.env` or keys.**
  If a key leaks, tell an organizer right away.
- Keep it friendly: your character will be on the big screen.
- Only assets you may use: the ones here, CC0 avatars from
  [opensourceavatars.com](https://www.opensourceavatars.com/), Mixamo
  animations, your own.

## Tips

- **One milestone at a time.** Test after each. When something breaks, give
  Kiro the exact error (server terminal, or browser console: F12).
- **Personality wins.** Not "a funny robot" but "a retired robot vacuum who
  writes bad poetry about dust and is secretly afraid of cats."
- **Voices:** Polly neural voices like Joanna, Matthew, Ivy, Kevin, Justin,
  Ruth, Stephen, Amy, Brian, Arthur, Olivia.
- **Another avatar?** Pick from **100Avatars Round 3** (avatars 201–300) on
  opensourceavatars.com: they have face expressions. Download the VRM into
  `public/avatars/`.
- **More moves?** [Mixamo](https://www.mixamo.com): FBX Binary, Without Skin,
  30 FPS, into `public/animations/`.

## When something goes wrong

| Problem | Fix |
|---|---|
| "security token ... invalid" | Check the key in `.env` (no spaces or quotes), and that your code loads `.env`. |
| `python`/`git`/`uv`/`aws` not found | Close and reopen PowerShell after installing. |
| Blank page or T-pose | Browser console (F12). Check paths, and "Technical notes" in REQUIREMENTS.md. |
| No sound | Click the page first: browsers block sound until you click. |
| It hears nothing | **Your microphone is muted**, or the wrong one is selected (icon next to the address bar). |
| My change doesn't show | Hard refresh: **Ctrl+Shift+R**. |
| "Address already in use" | Another server is running: Ctrl+C it, or use another port. |
| `start-session`: "SessionManagerPlugin is not found" | Install the plugin, reopen PowerShell. |
| `start-session`: "AccessDenied" | Use **your own** instance ID, and `aws configure` with your own key. |
| `git push`: "permission denied" / 403 | Push to **your fork** (`mine`), not to the original repo. |
| `deploy`: clone fails | Check the URL, and that your fork is **public**. |
| `deploy`: "needs main.py ... and pyproject.toml" | They must be at the top of your repo, and pushed. |

## Credits

Avatar: CoolPineapple, 100Avatars by Polygonal Mind (CC0). Animations:
Mixamo. Music: `dance.mp3` by the organizers.
