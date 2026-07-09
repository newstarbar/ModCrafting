export interface FormField {
  key: string
  label: string
  type: 'text' | 'select' | 'number' | 'checkbox' | 'textarea' | 'craftingGrid'
  defaultValue?: string | number | boolean
  options?: { label: string; value: string }[]
  placeholder?: string
  required?: boolean
  min?: number
  max?: number
  allowCustom?: boolean
  customPlaceholder?: string
  autoGenerateFrom?: string
}

export interface TemplateSchema {
  id: string
  name: string
  description: string
  fields: FormField[]
}

export function chineseToEnglishId(name: string): string {
  if (!name) return ''
  let result = name
    .replace(/[\u4e00-\u9fa5]/g, (char) => {
      const pinyinMap: Record<string, string> = {
        '自': 'zi', '定': 'ding', '义': 'yi', '方': 'fang', '块': 'kuai',
        '物': 'wu', '品': 'pin', '食': 'shi', '实': 'shi', '体': 'ti',
        '工': 'gong', '具': 'ju', '护': 'hu', '甲': 'jia', '配': 'pei',
        '方': 'fang', '魔': 'mo', '法': 'fa', '矿': 'kuang', '石': 'shi',
        '木': 'mu', '头': 'tou', '金': 'jin', '属': 'shu', '水': 'shui',
        '晶': 'jing', '泥': 'ni', '土': 'tu', '火': 'huo', '光': 'guang',
        '发': 'fa', '充': 'chong', '能': 'neng', '种': 'zhong', '植': 'zhi',
        '可': 'ke', '燃': 'ran', '掉': 'diao', '落': 'luo', '物': 'wu',
        '生': 'sheng', '长': 'chang', '测': 'ce', '试': 'shi', '武': 'wu',
        '器': 'qi', '材': 'cai', '料': 'liao', '近': 'jin', '战': 'zhan',
        '远': 'yuan', '程': 'cheng', '堆': 'dui', '叠': 'die', '耐': 'nai',
        '久': 'jiu', '度': 'du', '右': 'you', '键': 'jian', '使': 'shi',
        '用': 'yong', '食': 'shi', '用': 'yong', '投': 'tou', '掷': 'zhi',
        '被': 'bei', '动': 'dong', '敌': 'di', '对': 'dui', '中': 'zhong',
        '立': 'li', '飞': 'fei', '行': 'xing', '水': 'shui', '下': 'xia',
        '血': 'xue', '值': 'zhi', '小': 'xiao', '型': 'xing', '中': 'zhong',
        '大': 'da', '巨': 'ju', '型': 'xing', '鸡': 'ji', '牛': 'niu',
        '末': 'mo', '影': 'ying', '龙': 'long', '射': 'she', '送': 'song',
        '瞬': 'shun', '移': 'yi', '治': 'zhi', '疗': 'liao', '挖': 'wa',
        '掘': 'jue', '砍': 'kan', '伐': 'fa', '攻': 'gong', '击': 'ji',
        '多': 'duo', '功': 'gong', '能': 'neng', '范': 'fan', '围': 'wei',
        '破': 'po', '坏': 'huai', '自': 'zi', '动': 'dong', '耕': 'geng',
        '种': 'zhong', '精': 'jing', '准': 'zhun', '采': 'cai', '集': 'ji',
        '时': 'shi', '运': 'yun', '头': 'tou', '盔': 'kui', '胸': 'xiong',
        '腿': 'tui', '靴': 'xue', '全': 'quan', '套': 'tao', '皮': 'pi',
        '革': 'ge', '下': 'xia', '界': 'jie', '合': 'he', '金': 'jin',
        '防': 'fang', '护': 'hu', '火': 'huo', '焰': 'yan', '抗': 'kang',
        '水': 'shui', '下': 'xia', '呼': 'hu', '吸': 'xi', '夜': 'ye',
        '视': 'shi', '有': 'you', '序': 'xu', '无': 'wu', '熔': 'rong',
        '炉': 'lu', '酿': 'niang', '造': 'zao', '高': 'gao', '级': 'ji',
        '饮': 'yin', '品': 'pin', '增': 'zeng', '益': 'yi', '效': 'xiao',
        '果': 'guo', '食': 'shi', '腐': 'fu', '动': 'dong', '物': 'wu',
        '速': 'su', '度': 'du', '力': 'li', '量': 'liang', '跳': 'tiao',
        '跃': 'yue', '提': 'ti', '升': 'sheng'
      }
      return pinyinMap[char] || char
    })
    .replace(/[^a-z0-9_]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()

  if (!result) {
    result = name
      .replace(/[^a-z0-9]/gi, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase()
  }

  return result
}

export const templateSchemas: Record<string, TemplateSchema> = {
  'custom-block': {
    id: 'custom-block',
    name: '自定义方块',
    description: '创建一个全新的自定义方块',
    fields: [
      {
        key: 'blockName',
        label: '方块中文名称',
        type: 'text',
        placeholder: '如 自定义矿石',
        required: true
      },
      {
        key: 'blockId',
        label: '方块英文ID',
        type: 'text',
        placeholder: '如 custom_ore',
        autoGenerateFrom: 'blockName'
      },
      {
        key: 'materialStyle',
        label: '材质风格',
        type: 'select',
        defaultValue: 'stone',
        options: [
          { label: '石头', value: 'stone' },
          { label: '木头', value: 'wood' },
          { label: '金属', value: 'metal' },
          { label: '水晶', value: 'crystal' },
          { label: '泥土', value: 'dirt' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义材质风格...'
      },
      {
        key: 'hardness',
        label: '硬度值',
        type: 'number',
        defaultValue: 1.5,
        min: 0,
        max: 10,
        placeholder: '默认 1.5'
      },
      {
        key: 'resistance',
        label: '爆炸抗性',
        type: 'number',
        defaultValue: 6.0,
        min: 0,
        max: 100,
        placeholder: '默认 6.0'
      },
      {
        key: 'specialFeatures',
        label: '特殊功能',
        type: 'select',
        options: [
          { label: '无特殊功能', value: 'none' },
          { label: '发光', value: 'glowing' },
          { label: '可充能', value: 'powerable' },
          { label: '可种植', value: 'farmable' },
          { label: '可燃', value: 'flammable' },
          { label: '自定义掉落物', value: 'custom_drop' }
        ],
        defaultValue: 'none',
        allowCustom: true,
        customPlaceholder: '请输入自定义特殊功能...'
      },
      {
        key: 'customRender',
        label: '自定义渲染',
        type: 'select',
        defaultValue: 'no',
        options: [
          { label: '不需要', value: 'no' },
          { label: '方块实体', value: 'block_entity' },
          { label: '粒子效果', value: 'particles' },
          { label: '自定义模型', value: 'custom_model' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义渲染方式...'
      }
    ]
  },
  'custom-item': {
    id: 'custom-item',
    name: '自定义物品',
    description: '创建一个全新的自定义物品',
    fields: [
      {
        key: 'itemName',
        label: '物品中文名称',
        type: 'text',
        placeholder: '如 魔法棒',
        required: true
      },
      {
        key: 'itemId',
        label: '物品英文ID',
        type: 'text',
        placeholder: '如 magic_wand',
        autoGenerateFrom: 'itemName'
      },
      {
        key: 'itemType',
        label: '物品类型',
        type: 'select',
        defaultValue: 'normal',
        options: [
          { label: '普通物品', value: 'normal' },
          { label: '工具', value: 'tool' },
          { label: '武器', value: 'weapon' },
          { label: '材料', value: 'material' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义物品类型...'
      },
      {
        key: 'maxStackSize',
        label: '最大堆叠数',
        type: 'number',
        defaultValue: 64,
        min: 1,
        max: 64
      },
      {
        key: 'hasDurability',
        label: '是否有耐久度',
        type: 'select',
        defaultValue: 'no',
        options: [
          { label: '否', value: 'no' },
          { label: '是', value: 'yes' }
        ]
      },
      {
        key: 'specialEffect',
        label: '特殊效果',
        type: 'select',
        defaultValue: 'none',
        options: [
          { label: '无', value: 'none' },
          { label: '右键使用', value: 'right_click' },
          { label: '食用', value: 'food' },
          { label: '投掷', value: 'throwable' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义特殊效果...'
      }
    ]
  },
  'custom-food': {
    id: 'custom-food',
    name: '自定义食物',
    description: '创建一个全新的自定义食物',
    fields: [
      {
        key: 'foodName',
        label: '食物中文名称',
        type: 'text',
        placeholder: '如 魔法牛排',
        required: true
      },
      {
        key: 'foodId',
        label: '食物英文ID',
        type: 'text',
        placeholder: '如 magical_steak',
        autoGenerateFrom: 'foodName'
      },
      {
        key: 'hunger',
        label: '恢复饱食度',
        type: 'number',
        defaultValue: 6,
        min: 1,
        max: 20
      },
      {
        key: 'saturation',
        label: '饱和度',
        type: 'number',
        defaultValue: 0.6,
        min: 0,
        max: 5
      },
      {
        key: 'isMeat',
        label: '是否为肉类',
        type: 'select',
        defaultValue: 'no',
        options: [
          { label: '否', value: 'no' },
          { label: '是', value: 'yes' }
        ]
      },
      {
        key: 'effect',
        label: '食用后效果',
        type: 'select',
        defaultValue: 'none',
        options: [
          { label: '无', value: 'none' },
          { label: '速度', value: 'speed' },
          { label: '力量', value: 'strength' },
          { label: '跳跃提升', value: 'jump_boost' },
          { label: '夜视', value: 'night_vision' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义效果...'
      }
    ]
  },
  'custom-entity': {
    id: 'custom-entity',
    name: '自定义实体',
    description: '创建一个全新的自定义实体',
    fields: [
      {
        key: 'entityName',
        label: '实体中文名称',
        type: 'text',
        placeholder: '如 魔法生物',
        required: true
      },
      {
        key: 'entityId',
        label: '实体英文ID',
        type: 'text',
        placeholder: '如 magical_creature',
        autoGenerateFrom: 'entityName'
      },
      {
        key: 'entityType',
        label: '实体类型',
        type: 'select',
        defaultValue: 'passive',
        options: [
          { label: '被动生物', value: 'passive' },
          { label: '敌对生物', value: 'hostile' },
          { label: '中立生物', value: 'neutral' },
          { label: '飞行生物', value: 'flying' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义实体类型...'
      },
      {
        key: 'health',
        label: '生命值',
        type: 'number',
        defaultValue: 20,
        min: 1,
        max: 1000
      },
      {
        key: 'size',
        label: '实体大小',
        type: 'select',
        defaultValue: 'normal',
        options: [
          { label: '小型（如鸡）', value: 'small' },
          { label: '中型（如玩家）', value: 'normal' },
          { label: '大型（如牛）', value: 'large' },
          { label: '巨型（如末影龙）', value: 'huge' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义大小描述...'
      },
      {
        key: 'specialAbility',
        label: '特殊能力',
        type: 'select',
        defaultValue: 'none',
        options: [
          { label: '无', value: 'none' },
          { label: '飞行', value: 'fly' },
          { label: '发射投射物', value: 'projectile' },
          { label: '瞬移', value: 'teleport' },
          { label: '治疗其他生物', value: 'heal' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义特殊能力...'
      }
    ]
  },
  'custom-tool': {
    id: 'custom-tool',
    name: '自定义工具',
    description: '创建一个全新的自定义工具',
    fields: [
      {
        key: 'toolName',
        label: '工具中文名称',
        type: 'text',
        placeholder: '如 钻石镐',
        required: true
      },
      {
        key: 'toolId',
        label: '工具英文ID',
        type: 'text',
        placeholder: '如 diamond_pickaxe',
        autoGenerateFrom: 'toolName'
      },
      {
        key: 'toolType',
        label: '工具类型',
        type: 'select',
        defaultValue: 'pickaxe',
        options: [
          { label: '镐', value: 'pickaxe' },
          { label: '斧', value: 'axe' },
          { label: '剑', value: 'sword' },
          { label: '铲', value: 'shovel' },
          { label: '锄', value: 'hoe' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义工具类型...'
      },
      {
        key: 'material',
        label: '材质等级',
        type: 'select',
        defaultValue: 'diamond',
        options: [
          { label: '木头', value: 'wood' },
          { label: '石头', value: 'stone' },
          { label: '铁', value: 'iron' },
          { label: '金', value: 'gold' },
          { label: '钻石', value: 'diamond' },
          { label: '下界合金', value: 'netherite' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义材质...'
      },
      {
        key: 'durability',
        label: '耐久度',
        type: 'number',
        defaultValue: 1561,
        min: 1,
        max: 10000
      },
      {
        key: 'specialAbility',
        label: '特殊能力',
        type: 'select',
        defaultValue: 'none',
        options: [
          { label: '无', value: 'none' },
          { label: '范围破坏', value: 'area_mine' },
          { label: '自动耕种', value: 'auto_farm' },
          { label: '精准采集', value: 'silk_touch' },
          { label: '时运', value: 'fortune' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义特殊能力...'
      }
    ]
  },
  'custom-armor': {
    id: 'custom-armor',
    name: '自定义护甲',
    description: '创建一套全新的自定义护甲',
    fields: [
      {
        key: 'armorName',
        label: '护甲中文名称',
        type: 'text',
        placeholder: '如 龙鳞护甲',
        required: true
      },
      {
        key: 'armorId',
        label: '护甲英文ID',
        type: 'text',
        placeholder: '如 dragon_armor',
        autoGenerateFrom: 'armorName'
      },
      {
        key: 'armorType',
        label: '护甲类型',
        type: 'select',
        defaultValue: 'chestplate',
        options: [
          { label: '头盔', value: 'helmet' },
          { label: '胸甲', value: 'chestplate' },
          { label: '护腿', value: 'leggings' },
          { label: '靴子', value: 'boots' },
          { label: '全套', value: 'full_set' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义护甲类型...'
      },
      {
        key: 'material',
        label: '材质等级',
        type: 'select',
        defaultValue: 'diamond',
        options: [
          { label: '皮革', value: 'leather' },
          { label: '铁', value: 'iron' },
          { label: '金', value: 'gold' },
          { label: '钻石', value: 'diamond' },
          { label: '下界合金', value: 'netherite' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义材质...'
      },
      {
        key: 'protection',
        label: '防护值',
        type: 'number',
        defaultValue: 8,
        min: 1,
        max: 30
      },
      {
        key: 'specialEffect',
        label: '特殊效果',
        type: 'select',
        defaultValue: 'none',
        options: [
          { label: '无', value: 'none' },
          { label: '火焰抗性', value: 'fire_resistance' },
          { label: '水下呼吸', value: 'water_breathing' },
          { label: '飞行', value: 'flight' },
          { label: '夜视', value: 'night_vision' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义效果...'
      }
    ]
  },
  'custom-recipe': {
    id: 'custom-recipe',
    name: '自定义配方',
    description: '创建一个全新的合成配方',
    fields: [
      {
        key: 'recipeId',
        label: '配方名称',
        type: 'text',
        placeholder: '如 magic_wand_recipe',
        required: true
      },
      {
        key: 'recipeType',
        label: '配方类型',
        type: 'select',
        defaultValue: 'shaped',
        options: [
          { label: '有序合成', value: 'shaped' },
          { label: '无序合成', value: 'shapeless' },
          { label: '熔炉配方', value: 'smelting' },
          { label: '酿造配方', value: 'brewing' }
        ],
        allowCustom: true,
        customPlaceholder: '请输入自定义配方类型...'
      },
      {
        key: 'craftingGrid',
        label: '合成网格',
        type: 'craftingGrid'
      }
    ]
  }
}

export interface CraftingGridData {
  grid: { itemId: string; count: number }[][]
  outputItem: string
  outputCount: number
}

export function generatePromptFromForm(templateId: string, formData: Record<string, unknown>): string {
  const schema = templateSchemas[templateId]
  if (!schema) return `我需要创建一个${templateId}模组。请输出结构化实施计划。`

  let prompt = `我需要创建一个${schema.name}模组，模板ID：${templateId}。\n\n详细信息：\n`

  for (const field of schema.fields) {
    const value = formData[field.key]
    if (value !== undefined && value !== null && value !== '') {
      const label = field.label
      let displayValue = String(value)

      if (field.type === 'select' && field.options) {
        const option = field.options.find(o => o.value === value)
        if (option) {
          displayValue = option.label
        }
      }

      if (field.type === 'craftingGrid') {
        const gridData = value as CraftingGridData
        if (gridData) {
          const { grid, outputItem, outputCount } = gridData
          prompt += `- 输出物品：${outputItem} x${outputCount}\n`
          prompt += `- 输入材料：\n`
          
          const materials: Record<string, number> = {}
          grid.forEach(row => {
            row.forEach(slot => {
              if (slot.itemId) {
                materials[slot.itemId] = (materials[slot.itemId] || 0) + (slot.count || 1)
              }
            })
          })
          
          if (Object.keys(materials).length === 0) {
            prompt += `  无（空配方）\n`
          } else {
            Object.entries(materials).forEach(([itemId, count]) => {
              prompt += `  - ${itemId} x${count}\n`
            })
          }

          prompt += `- 合成形状（3x3网格）：\n`
          grid.forEach(row => {
            const rowStr = row.map(slot => slot.itemId ? 'X' : '.').join(' ')
            prompt += `  ${rowStr}\n`
          })
          continue
        }
      }

      prompt += `- ${label}：${displayValue}\n`
    }
  }

  prompt += '\n请输出结构化实施计划，每行一个步骤：`N. [kind] 简短标题 — 目标路径`，其中 kind 为 write 或 inspect。'

  return prompt
}
