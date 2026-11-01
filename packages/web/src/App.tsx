import { useEffect, useState, type ComponentType } from 'react';
import { CanvasPage, QueuePage } from './canvas';
import { InboxPage, NewSessionPage, OnboardingPage, ReviewPage, SettingsPage } from './flows';

const ROUTES: Record<string, ComponentType> = {
  canvas: CanvasPage,
  queue: QueuePage,
  new: NewSessionPage,
  review: ReviewPage,
  inbox: InboxPage,
  settings: SettingsPage,
  onboarding: OnboardingPage,
};

function currentRoute(): string {
  const name = location.hash.replace(/^#\/?/, '').split('/')[0] ?? '';
  return name in ROUTES ? name : 'canvas';
}

export function App() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);

  const Page = ROUTES[route] ?? CanvasPage;
  return <Page />;
}
