/**
 * Emoji 选择面板：嵌入工具栏「批注 / 插入 Emoji」下拉中，按分类列出常用 emoji。
 *
 * 不引入第三方 emoji 数据库（emoji-mart 等体积 ~500KB+），用手写常用集 ~280 个。
 * 90% 文档场景够用；用户输入特殊 emoji 仍可直接粘贴。
 *
 * 选中后通过 editor.chain().focus().insertContent(emoji) 插入到光标处。
 */
import { useState } from "react";
import type { Editor } from "@tiptap/react";

const CATEGORIES: { key: string; label: string; icon: string; emojis: string }[] = [
  {
    key: "common",
    label: "常用",
    icon: "⭐",
    emojis: "😀 😂 🥰 😍 🤔 😎 😴 🥺 ❤️ 👍 👎 👏 🙏 🎉 🔥 💯 ✨ ⭐ ✅ ❌ ⚠️ 💡 📌 🚀",
  },
  {
    key: "smileys",
    label: "表情",
    icon: "😊",
    emojis:
      "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐",
  },
  {
    key: "gestures",
    label: "手势",
    icon: "👍",
    emojis:
      "👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾",
  },
  {
    key: "people",
    label: "人物",
    icon: "👨",
    emojis:
      "👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 👮 🕵 💂 👷 🤴 👸 👲 🧕 🤵 👰 🤰 🤱 👼 🎅 🤶 🦸 🦹 🧙 🧚 🧛 🧜 🧝 🧞 🧟 💁 🙅 🙆 🙋 🧏 🤦 🤷 🙇 🤳 💆 💇 🚶 🏃 💃 🕺",
  },
  {
    key: "animals",
    label: "动物",
    icon: "🐶",
    emojis:
      "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐒 🦄 🐴 🦓 🦒 🦌 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🐝 🐛 🦋 🐌 🐞 🐜 🦗 🕷 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊",
  },
  {
    key: "food",
    label: "食物",
    icon: "🍎",
    emojis:
      "🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶 🌽 🥕 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪",
  },
  {
    key: "activities",
    label: "活动",
    icon: "⚽",
    emojis:
      "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🎱 🪀 🏓 🏸 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛷 ⛸ 🥌 🎿 ⛷ 🏂 🪂 🏋 🤼 🤸 ⛹ 🤺 🤾 🏌 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖 🏵 🎗 🎫 🎟 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎵 🎶 🥁 🎷 🎺 🎸 🪕 🎻",
  },
  {
    key: "objects",
    label: "物品",
    icon: "💡",
    emojis:
      "💡 🔦 🕯 🪔 🧯 🛢 💸 💵 💴 💶 💷 🪙 💰 💳 🧾 ✉️ 📧 📨 📩 📤 📥 📦 🏷 📪 📫 📬 📭 📮 🗳 ✏️ ✒️ 🖋 🖊 🖌 🖍 📝 💼 📁 📂 🗂 📅 📆 🗒 🗓 📇 📈 📉 📊 📋 📌 📍 📎 🖇 📏 📐 ✂️ 🗃 🗄 🗑 🔒 🔓 🔏 🔐 🔑 🗝 🔨 🪓 ⛏ ⚒ 🛠 🗡 ⚔️ 🔫 🪃 🏹 🛡 🪚 🔧 🪛 🔩 ⚙️ 🗜 ⚖️ 🦯 🔗 ⛓ 🪝 🧰 🧲 🪜 ⚗️ 🧪 🧫 🧬 🔬 🔭 📡 💉 🩸 💊",
  },
  {
    key: "symbols",
    label: "符号",
    icon: "❤️",
    emojis:
      "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉 ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈️ ♉️ ♊️ ♋️ ♌️ ♍️ ♎️ ♏️ ♐️ ♑️ ♒️ ♓️ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚️ 🈸 🈺 🈷 ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕️ 🛑 ⛔️ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗️ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯️ 💹 ❇️ ✳️ ❎ 🌐 💠",
  },
  // 旗帜（不含国旗）：Windows 默认 Segoe UI Emoji 不支持区域指示符
  // 双字符组合（🇨🇳/🇺🇸 等会显示成 "CN"/"US" 字母），所以只放普通旗帜符号
  {
    key: "flags",
    label: "旗帜",
    icon: "🚩",
    emojis: "🏳️ 🏴 🏁 🚩 🏳️‍🌈 🏳️‍⚧️ 🏴‍☠️",
  },
];

interface EmojiPanelProps {
  editor: Editor;
  /** 插入 emoji 后的回调（例如关闭外层下拉） */
  onInsert?: () => void;
}

/**
 * 纯面板内容（分类条 + emoji 网格），可嵌入 Popover 或 Dropdown 使用。
 */
export function EmojiPanel({ editor, onInsert }: EmojiPanelProps) {
  const [activeKey, setActiveKey] = useState<string>("common");

  function insertEmoji(emoji: string) {
    editor.chain().focus().insertContent(emoji).run();
    onInsert?.();
  }

  function stopMouseDown(e: React.MouseEvent) {
    e.stopPropagation();
  }

  const active = CATEGORIES.find((c) => c.key === activeKey) ?? CATEGORIES[0];

  return (
    <div onMouseDown={stopMouseDown} style={{ width: 380 }}>
      {/* 顶部水平分类条：emoji 图标按钮，紧凑布局，10 个全部直接展示 */}
      <div className="emoji-cat-bar">
        {CATEGORIES.map((cat) => (
          <button
            type="button"
            key={cat.key}
            className={`emoji-cat-btn ${cat.key === activeKey ? "active" : ""}`}
            onClick={() => setActiveKey(cat.key)}
          >
            {cat.label}
          </button>
        ))}
      </div>
      {/* 当前分类的 emoji 网格 */}
      <div
        className="emoji-grid"
        style={{ maxHeight: 280, overflowY: "auto", paddingRight: 4 }}
      >
        {active.emojis.split(/\s+/).filter(Boolean).map((e, i) => (
          <button
            type="button"
            key={`${e}-${i}`}
            className="emoji-grid-item"
            onClick={() => insertEmoji(e)}
            title={e}
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
