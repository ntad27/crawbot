import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// EN
import enCommon from './locales/en/common.json';
import enSettings from './locales/en/settings.json';
import enDashboard from './locales/en/dashboard.json';
import enChat from './locales/en/chat.json';
import enChannels from './locales/en/channels.json';
import enSkills from './locales/en/skills.json';
import enCron from './locales/en/cron.json';
import enAgents from './locales/en/agents.json';
import enSetup from './locales/en/setup.json';
import enWorkflow from './locales/en/workflow.json';

// VI
import viCommon from './locales/vi/common.json';
import viSettings from './locales/vi/settings.json';
import viDashboard from './locales/vi/dashboard.json';
import viChat from './locales/vi/chat.json';
import viChannels from './locales/vi/channels.json';
import viSkills from './locales/vi/skills.json';
import viCron from './locales/vi/cron.json';
import viAgents from './locales/vi/agents.json';
import viSetup from './locales/vi/setup.json';
import viWorkflow from './locales/vi/workflow.json';

export const SUPPORTED_LANGUAGES = [
    { code: 'en', label: 'English' },
    { code: 'vi', label: 'Tiếng Việt' },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

const resources = {
    en: {
        common: enCommon,
        settings: enSettings,
        dashboard: enDashboard,
        chat: enChat,
        channels: enChannels,
        skills: enSkills,
        cron: enCron,
        agents: enAgents,
        setup: enSetup,
        workflow: enWorkflow,
    },
    vi: {
        common: viCommon,
        settings: viSettings,
        dashboard: viDashboard,
        chat: viChat,
        channels: viChannels,
        skills: viSkills,
        cron: viCron,
        agents: viAgents,
        setup: viSetup,
        workflow: viWorkflow,
    },
};

i18n
    .use(initReactI18next)
    .init({
        resources,
        lng: 'en', // will be overridden by settings store
        fallbackLng: 'en',
        defaultNS: 'common',
        ns: ['common', 'settings', 'dashboard', 'chat', 'channels', 'skills', 'cron', 'agents', 'setup', 'workflow'],
        interpolation: {
            escapeValue: false, // React already escapes
        },
        react: {
            useSuspense: false,
        },
    });

export default i18n;
