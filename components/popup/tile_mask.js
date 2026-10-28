import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as utils from '../../conveniences/utils.js';
import * as uniforms from '../../render/shader/uniforms.js';

const SHADER_SOURCE = utils.get_shader_source(Shell, 'tile_mask.glsl', import.meta.url);

export const MAX_TILES = 16;
const TILE_STYLE_CLASSES = ['quick-toggle-has-menu', 'quick-toggle', 'quick-slider'];
const SYSTEM_ITEM_STYLE_CLASS = 'quick-settings-system-item';

function has_any_class(actor, classes) {
    return actor instanceof St.Widget && classes.some(c => actor.has_style_class_name(c));
}

/// The quick settings tiles (toggles, sliders, round buttons of the top row), outermost only.
export function find_quick_settings_tiles(box) {
    const tiles = [];
    const walk = (actor, in_system_item) => {
        if (!actor.visible)
            return;
        if (has_any_class(actor, TILE_STYLE_CLASSES)
            || in_system_item && has_any_class(actor, ['icon-button', 'power-item'])) {
            tiles.push(actor);
            return;
        }
        const system_item = in_system_item || has_any_class(actor, [SYSTEM_ITEM_STYLE_CLASS]);
        actor.get_children().forEach(child => walk(child, system_item));
    };
    walk(box, false);
    return tiles.slice(0, MAX_TILES);
}

/// Masks a blur actor so that it only shows behind the quick settings tiles of `box`.
/// Tile geometry is read at each paint, so it follows the opening animation and layout changes.
const TileMaskEffectClass = class TileMaskEffect extends utils.ShaderEffect {
    constructor() {
        super();
        this.box = null;
        utils.initialize_shader_effect(this, SHADER_SOURCE);
    }

    static get default_params() {
        return {};
    }

    set_box(box) {
        this.box = box;
        this.queue_repaint();
    }

    update_tiles() {
        const actor = this.get_actor();
        if (!actor || !this.box)
            return;

        const tiles = find_quick_settings_tiles(this.box);
        let count = 0;
        for (const tile of tiles) {
            if (!tile.has_allocation())
                continue;
            const [x, y] = tile.get_transformed_position();
            const [width, height] = tile.get_transformed_size();
            const [ok1, x1, y1] = actor.transform_stage_point(x, y);
            const [ok2, x2, y2] = actor.transform_stage_point(x + width, y + height);
            if (!ok1 || !ok2 || x2 <= x1 || y2 <= y1)
                continue;
            uniforms.set_uniform(this, `t${count}x`, x1);
            uniforms.set_uniform(this, `t${count}y`, y1);
            uniforms.set_uniform(this, `t${count}w`, x2 - x1);
            uniforms.set_uniform(this, `t${count}h`, y2 - y1);
            count++;
        }
        uniforms.set_uniform(this, 'tile_count', count);
    }

    vfunc_paint_target(node, context) {
        if (this.target) {
            const box = [this.target.x, this.target.y,
                this.target.logicalWidth, this.target.logicalHeight];
            ['texture_x', 'texture_y', 'texture_width', 'texture_height'].forEach(
                (name, index) => uniforms.set_uniform(this, name, box[index])
            );
        }
        this.update_tiles();
        uniforms.upload_uniforms(this);
        super.vfunc_paint_target(node, context);
    }
};

export const TileMaskEffect = GObject.registerClass(
    { GTypeName: 'BmsPopupTileMaskEffect' }, TileMaskEffectClass);
