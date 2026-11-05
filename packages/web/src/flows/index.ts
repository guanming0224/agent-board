import './flows.css';
import { registerMessages } from '../shared/i18n';
import { restoreLocale } from './locale';
import { en, zhTW } from './messages';

registerMessages('zh-TW', zhTW);
registerMessages('en', en);
restoreLocale();

export { ArchivePage } from './ArchivePage';
export { InboxPage } from './InboxPage';
export { LoginPage } from './LoginPage';
export { NewSessionPage } from './NewSessionPage';
export { QuickCreate } from './QuickCreate';
export { OnboardingPage } from './OnboardingPage';
export { ReviewPage, SessionReviewCards } from './ReviewPage';
export { SettingsPage } from './SettingsPage';
export { Dialog } from './Dialog';
