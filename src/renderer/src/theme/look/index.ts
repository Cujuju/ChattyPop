// The look vocabulary (docs/plugin-architecture.md §14): the theme's class roles for how things look, one map for plugins.
import controls from './controls.module.css';
import data from './data.module.css';
import marks from './marks.module.css';
import messageBox from './messageBox.module.css';
import surfaces from './surfaces.module.css';
import text from './text.module.css';

/** Class per role: the element keeps its own structural class beside it (`${styles.row} ${look.row}`). Role names are unique across files. */
export const look: CSSModuleClasses = { ...text, ...surfaces, ...controls, ...marks, ...data, ...messageBox };
