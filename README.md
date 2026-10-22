# Lakr Agentation 0.1.5

Make launch films, product demos and motion pieces with Lakr from inside your agent: storyboard, write scenes against the Lakr kit, watch them build live in a browser preview, click anything to change it, render the MP4.

Your agent writes the film as code against Lakr's kit. You watch it build live in a browser tab, pause it, click any
element and say what should change; your agent changes exactly that. Then it renders the MP4 into your project.

## Claude Code

    /plugin marketplace add johntony1/lakr-agentation
    /plugin install lakr-agentation@lakr

Then ask: "make a 30 second launch film for <your product> with Lakr" (attach or name any assets you want used) (or `/lakr-agentation:film <idea>`).

## Codex

    git clone https://github.com/johntony1/lakr-agentation && sh lakr-agentation/codex/install.sh

Registers the `lakr` MCP server in ~/.codex/config.toml and installs the skill in ~/.agents/skills. Codex asks you to
approve each Lakr tool the first time.

## Needs

Node 22+ · Chrome (or Chromium, Edge, Brave) for stills, checks and renders · ffmpeg for renders and the library's
frames. Sounds and music use your Lakr account: the first time, the agent opens your browser to sign in.

## What's inside

- `plugins/lakr-agentation/`: the plugin (skill, MCP server, live preview, Lakr's player, guides and library).
- `codex/`: the same server and skill for Codex.

Lakr © Lakr (https://lakr.app). Bundled HyperFrames pieces are Apache-2.0; the player bundles Remotion (Remotion
License), React (MIT) and @paper-design/shaders. See plugins/lakr-agentation/LICENSE.md.
