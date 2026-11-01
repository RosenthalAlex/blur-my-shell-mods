# Blur my Shell – modified

A modified copy of [Blur my Shell](https://github.com/aunetx/blur-my-shell) version 76
(as installed from extensions.gnome.org), tested on GNOME 51.

## Changes

- **Applications: blur only windows with transparency.** New option `auto-detect`
  (under *Enable all by default*): each window is looked at once and blurred only if parts of
  it are translucent. The blur behind opaque windows is never visible but costs as much to
  render. Applications found translucent are remembered so that their next windows are blurred
  from the first frame.
- **Overview:** the background blur and the workspace shadow fade in and out with the overview
  transition instead of switching at once.
- **Popups:** new option `quick-settings-tiles`: the quick settings panel itself is not blurred,
  only its tiles, sliders and buttons (one blur masked to their shapes).

## Install

Copy the files to `~/.local/share/gnome-shell/extensions/blur-my-shell@aunetx/`, run
`glib-compile-schemas schemas/` there, then log out and back in.

## License

GPL-3.0, like the original extension (see `LICENSE`).
