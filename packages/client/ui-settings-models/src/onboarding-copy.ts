/** Durable settings namespace for product-wide GUI onboarding facts. */
export const WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-onboarding'

/** Field storing the last welcome notice version the user acknowledged. */
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'

/**
 * Bump only when the notice changes materially and every user should see it
 * again. The acknowledgement is compared for exact equality.
 */
export const WELCOME_NOTICE_VERSION = '2026-09-07.1'

/** The complete technical-preview notice in both supported GUI locales. */
export const WELCOME_NOTICE_COPY = {
  zh: {
    title: 'DSH Context Map 技术预览',
    body: 'DSH Context Map 目前处于技术预览阶段，Context Map 交互、上下文编译和相关 API 仍可能快速迭代。欢迎通过项目仓库反馈使用体验与问题。\n\n本项目基于 DeepSeek Harness 构建，由社区独立维护，不隶属于 DeepSeek AI，也不代表其官方发行版。',
    continueLabel: '继续',
  },
  en: {
    title: 'DSH Context Map Technical Preview',
    body: 'DSH Context Map is currently a technical preview. Its Context Map interactions, context compiler, and related APIs may evolve quickly; feedback and issue reports are welcome in the project repository.\n\nThis independently maintained community project is built on DeepSeek Harness. It is not affiliated with, endorsed by, or an official distribution of DeepSeek AI.',
    continueLabel: 'Continue',
  },
} as const
