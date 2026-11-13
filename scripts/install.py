#!/usr/bin/env python3
"""Install the Sessions sidebar into the Herdr app, update it, or take it out.

    python3 scripts/install.py            install, or update an installed copy
    python3 scripts/install.py --remove   put back the layouts it changed and delete the mod

The mod goes to <app home>/mods/agent-sidebar (the app home is ~/.config/herdr-app, or
$HERDR_APP_HOME). In the layout Herdr shows, it takes the place of Herdr's Spaces and Agents
lists; other blocks in the sidebar stay below it. The chrome footer goes, because the sidebar
carries Settings and Add machine. Herdr's own layouts are read-only, so when one of those is
showing, the sidebar goes into a copy of it called <name>-agents (a copy of `main` when the shown
one has no sidebar). A personal layout is backed up to <name>.json.before-agents first.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

SOURCE = Path(__file__).resolve().parent.parent
APP_HOME = Path(os.environ.get("HERDR_APP_HOME", Path.home() / ".config/herdr-app"))
MOD = "agent-sidebar"
BLOCK = "sessions"
SUFFIX = "-agents"  # the copy of one of Herdr's own layouts
BACKUP = ".before-agents"  # appended to a personal layout's file name
REPLACES = {"spaces", "agents"}  # Herdr's lists that this sidebar shows in one
PREVIEW = SOURCE / "layouts" / "main-agents.svg"
HERDR_FILES = ("*.d.ts", "jsconfig.json", "*.error")  # Herdr writes these into mod folders


def herdr(app, *args):
    return subprocess.run([app, *args], check=True, timeout=60, capture_output=True, text=True)


def ours(folder):
    try:
        return json.loads((folder / "mod.json").read_text()).get("title") == "Sessions" and (folder / "launcher.js").exists()
    except (OSError, ValueError):
        return False


def write_json(path, value):
    temp = path.with_name(f".{path.name}.tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    temp.replace(path)


def walk(node, parent=None):
    yield node, parent
    for child in node.get("children", []):
        yield from walk(child, node)


def mod_of(node):
    content = node.get("content")
    return content.get("mod") if isinstance(content, dict) else None


def has_mod(layout):
    return any(mod_of(node) == MOD for node, _ in walk(layout))


def our_copy(name, layout):
    """The copy of one of Herdr's layouts that the installer made."""
    return name.endswith(SUFFIX) and (layout.get("cloned_from") or {}).get("name") == name[: -len(SUFFIX)]


def has_sidebar(layout):
    ids = {node.get("id") for node, _ in walk(layout)}
    return "sidebar" in ids and "sidebar-lists" in ids


def shipped():
    """Herdr's own layouts, which it may replace on update."""
    try:
        names = {k[len("layout:"):] for k in json.loads((APP_HOME / "installed.json").read_text()) if k.startswith("layout:")}
    except (OSError, ValueError):
        names = set()
    return names or {"main", "terminals", "win98"}


def patch(layout):
    """Put the sessions sidebar into a layout tree, in place. Safe to run on a tree that has it."""
    nodes = {node.get("id"): node for node, _ in walk(layout)}
    sidebar, lists = nodes.get("sidebar"), nodes.get("sidebar-lists")
    if not sidebar or not lists:
        raise ValueError("this layout has no sidebar lists to replace")
    if not has_mod(layout):
        kept = [node for node in lists.get("children", []) if mod_of(node) not in REPLACES]
        block = {"id": BLOCK, "type": "block", "size": {"weight": 2}, "min": 90, "content": {"mod": MOD}}
        lists["children"] = [block, *kept]
    # Settings and Add machine are in the sidebar's header, so the chrome footer goes.
    sidebar["children"] = [node for node in sidebar.get("children", []) if node.get("id") != "sidebar-footer"]
    # Outside agents are already in this sidebar; drop a separately docked Outside panel.
    layout["children"] = [node for node in layout.get("children", []) if mod_of(node) != "outside"]
    return layout


def unpatch(layout, before, everything=True):
    """Take the sessions sidebar's block out of a layout tree, in place, and put back what patch()
    took out, as `before` had it: Herdr's lists where the block was, and with `everything`, the
    footer and a docked Outside panel. What the layout has gained since stays."""
    had = {node.get("id"): (node, parent) for node, parent in walk(before)}
    ids = {node.get("id") for node, _ in walk(layout)}
    lists = [child for child in had.get("sidebar-lists", ({}, None))[0].get("children", [])
             if mod_of(child) in REPLACES and child.get("id") not in ids]
    for node in [node for node, _ in walk(layout)]:
        if "children" not in node:
            continue
        children = []
        for child in node["children"]:
            if mod_of(child) == MOD:
                children.extend(copy.deepcopy(lists))
                lists = []
            else:
                children.append(child)
        node["children"] = children
    if everything:
        nodes = {node.get("id"): node for node, _ in walk(layout)}
        gone = [(node, parent) for node, parent in had.values() if parent is not None and node.get("id") not in nodes
                and (node.get("id") == "sidebar-footer" or mod_of(node) == "outside")]
        for node, parent in gone:
            target = nodes.get(parent.get("id"))
            if target is not None and "children" in target:
                target["children"].insert(min(parent["children"].index(node), len(target["children"])), copy.deepcopy(node))
    if layout.get("preview") == f"layouts/{PREVIEW.name}":
        del layout["preview"]
    return layout


def mod_files():
    folder = SOURCE / "mods" / MOD
    return [p for p in sorted(folder.iterdir()) if p.is_file() and not any(p.match(g) for g in HERDR_FILES)]


def install_mod(app):
    herdr(app, "check", str(SOURCE / "mods" / MOD))
    dest = APP_HOME / "mods" / MOD
    if dest.exists() and not ours(dest):
        sys.exit(f"{dest} exists and isn't this mod. Nothing was changed.")
    saved = Path(tempfile.mkdtemp(prefix="agent-sidebar-")) / MOD
    try:
        if dest.exists():
            shutil.copytree(dest, saved)
        dest.mkdir(parents=True, exist_ok=True)
        files = mod_files()
        # The entry point goes last, so a live reload finds the modules it imports.
        for path in sorted(files, key=lambda p: p.name == "main.js"):
            shutil.copyfile(path, dest / path.name)
        # Then what an older version had and this one doesn't.
        names = {path.name for path in files}
        for old in dest.iterdir():
            if old.is_file() and old.name not in names and not any(old.match(g) for g in HERDR_FILES):
                old.unlink()
        herdr(app, "check", str(dest))
    except BaseException:
        # Back to what was there: the previous version, or nothing.
        shutil.rmtree(dest, ignore_errors=True)
        if saved.exists():
            shutil.copytree(saved, dest)
        raise
    finally:
        shutil.rmtree(saved.parent, ignore_errors=True)


def wait_for(path):
    for _ in range(50):
        if path.exists():
            return
        time.sleep(0.1)
    raise OSError(f"Herdr didn't write {path}")


def add_to_layout(app):
    layouts = APP_HOME / "layouts"
    shown = json.loads(herdr(app, "status").stdout).get("layout") or "main"
    name, note = shown, ""
    if shown in shipped():
        source = shown
        try:
            if not has_sidebar(json.loads((layouts / f"{shown}.json").read_text())):
                source, note = "main", f"{shown} has no sidebar, so this uses a copy of main. "
        except (OSError, ValueError):
            source = "main"
        name = f"{source}{SUFFIX}"
        if not (layouts / f"{name}.json").exists():
            herdr(app, "do", "layout.clone", "--name", source, "--as", name)
            wait_for(layouts / f"{name}.json")
    path = layouts / f"{name}.json"
    before = path.read_text()
    layout = patch(json.loads(before))
    if name == f"main{SUFFIX}" and PREVIEW.exists():
        shutil.copyfile(PREVIEW, layouts / PREVIEW.name)
        layout["preview"] = f"layouts/{PREVIEW.name}"
    if json.loads(before) != layout:
        backup = path.with_name(f"{path.name}{BACKUP}")
        # A layout of your own, before the sidebar first went into it.
        if name == shown and not our_copy(name, layout) and not has_mod(json.loads(before)) and not backup.exists():
            backup.write_text(before)
        write_json(path, layout)
        time.sleep(1)  # Herdr watches layouts asynchronously
    herdr(app, "do", "layout.switch", "--name", name)
    return name, note


def remove(app):
    layouts = APP_HOME / "layouts"
    try:
        shown = json.loads(herdr(app, "status").stdout).get("layout") if app else None
    except (subprocess.SubprocessError, ValueError):
        shown = None
    done = []
    for path in sorted(layouts.glob("*.json")):
        try:
            layout = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not has_mod(layout):
            continue
        name = path.stem
        backup = path.with_name(f"{path.name}{BACKUP}")
        source = (layout.get("cloned_from") or {}).get("name")
        try:
            before = json.loads(backup.read_text()) if backup.exists() else None
        except (OSError, ValueError):
            before = None
        if before is not None and patch(copy.deepcopy(before)) == layout:
            backup.replace(path)
            done.append(f"put back {name} as it was before")
        elif before is not None:
            # Changed since: keep the changes, and the backup.
            write_json(path, unpatch(layout, before))
            done.append(f"took the sidebar out of {name}, kept what changed there since, and left the backup as {backup.name}")
        elif our_copy(name, layout):
            if shown == name and app:
                herdr(app, "do", "layout.switch", "--name", source)
            path.unlink()
            preview = layouts / PREVIEW.name
            if layout.get("preview") == f"layouts/{PREVIEW.name}" and preview.exists() and not any(
                    json.loads(p.read_text()).get("preview") == f"layouts/{PREVIEW.name}" for p in layouts.glob("*.json")):
                preview.unlink()
            done.append(f"deleted {name}, the copy of {source} it made")
        else:
            # Not put in by the installer: Herdr's lists come back, from its main layout.
            try:
                main = json.loads((layouts / "main.json").read_text())
            except (OSError, ValueError):
                main = {}
            write_json(path, unpatch(layout, main, everything=False))
            done.append(f"took the sidebar out of {name}")
    dest = APP_HOME / "mods" / MOD
    if dest.exists():
        if not ours(dest):
            sys.exit(f"{dest} isn't this mod, so it stays.")
        shutil.rmtree(dest)
        done.append("deleted the mod")
    return done


def main():
    app = shutil.which("herdr-app")
    if "--remove" in sys.argv[1:]:
        done = remove(app)
        print("Removed the Sessions sidebar: " + "; ".join(done) + "." if done else "The Sessions sidebar isn't installed.")
        return
    if not app or not (APP_HOME / "layouts/main.json").exists():
        sys.exit("Start Herdr once before installing.")
    install_mod(app)
    name, note = add_to_layout(app)
    print(f"{note}Herdr shows {name} with the Sessions sidebar. Run this again to update it, or with --remove to take it out.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(f"Stopped: herdr-app {' '.join(error.cmd[1:3])} failed: {(error.stderr or error.stdout or '').strip()}")
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        sys.exit(f"Stopped: {error}")
