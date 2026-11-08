// 對話紀錄 `#/transcript/<id>?at=<序號>`（P3 ③b）：全域搜尋按 ⌘Enter 開這裡，捲到命中的那則。
// 活著的與已結束的 session 都能看（舊資料頁 `#/archive/<id>` 只有封存的）；內容由 daemon 讀，hub 不存。
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import {
  Callsign,
  callsign,
  Empty,
  ErrorBox,
  Lamp,
  Loading,
  Page,
  useLoad,
  useProjects,
} from './common';
import { transcriptTarget } from '../views/overlay';
import { Transcript } from './ArchivePage';

function useHashTarget() {
  const [target, setTarget] = useState(() => transcriptTarget(location.hash));
  useEffect(() => {
    const onChange = () => setTarget(transcriptTarget(location.hash));
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return target;
}

export function TranscriptPage() {
  const t = useT();
  const { id, at } = useHashTarget();
  const { backend, sessions, machines } = useBoard();
  const projects = useProjects();
  const live = sessions.find((s) => s.id === id) ?? null;
  // 不在畫布上的（封存的）才去讀封存清單。
  const archived = useLoad(
    useCallback(
      () => (live || !id ? Promise.resolve([]) : backend.listArchivedSessions()),
      [backend, live, id],
    ),
  );
  const session = live ?? archived.data?.find((s) => s.id === id) ?? null;
  const machine = machines.find((m) => m.id === session?.machineId);
  const machineName = machine?.name ?? session?.machineId ?? '';

  let body;
  if (!live && archived.error) {
    body = <ErrorBox what={archived.error} how={t('flows.retryHow')} onRetry={archived.reload} />;
  } else if (!session && archived.loading) {
    body = <Loading />;
  } else if (!session) {
    body = (
      <Empty
        title={t('flows.archive.notFound')}
        next={<a href="#/canvas">{t('flows.archive.toCanvas')}</a>}
      />
    );
  } else {
    body = (
      <>
        <header className="page-head archive-head">
          <h1>{session.name}</h1>
          <Lamp status={session.status} detail={session.statusDetail} />
        </header>
        <Callsign text={callsign(session, machines, projects.data ?? [])} />
        <Transcript
          key={`${session.id}:${at ?? ''}`}
          session={session}
          machineName={machineName}
          online={machine?.online ?? false}
          focusIndex={at}
        />
      </>
    );
  }
  return <Page>{body}</Page>;
}
