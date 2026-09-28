import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { Toaster } from 'sonner';
import en from '../src/renderer/src/i18n/locales/en.json';
import { UploadZone } from '../src/renderer/src/features/clone/reference-input';
import { useReference } from '../src/renderer/src/lib/store/reference';

await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } });

function Fixture() {
  const ref = useReference();
  return (
    <>
      <UploadZone />
      <output id="result">
        {JSON.stringify({
          name: ref.file?.name,
          type: ref.file?.type,
          duration: ref.durationSeconds,
        })}
      </output>
      <audio src={ref.objectUrl ?? undefined} controls />
      <Toaster />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
