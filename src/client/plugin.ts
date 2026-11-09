/** 本插件在宿主注册面里的包名：槽位 id 与插件设置页 key 都长在它上面（`${PLUGIN_ID}.trash` 这类）。 */
export const PLUGIN_ID = '@xrn1997/dsh-session-delete'

/** 同一身份的点号写法：宿主的 `contextMenu.icon` key 与 `contextMenus` 贡献 id 用它。
 *  这些名字由宿主按字面派发（key 撞上别人已占的那一格会顶掉占用者），所以它必须是本插件专属的；
 *  点号形式与包名同源，改名时与 {@link PLUGIN_ID} 一起改，不在调用点另写一份字面量。 */
export const PLUGIN_KEY_PREFIX = 'xrn1997.session-delete'
