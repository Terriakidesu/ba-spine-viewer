import { useState } from "react";
import type { TimelineLanguage } from "./editorModel";
import "./subtitleTextEditor.css";

const LANGUAGES: readonly TimelineLanguage[] = ["en", "ja", "ko"];

interface SubtitleTextEditorProps {
  cueNumber: number;
  language: TimelineLanguage;
  text: Record<TimelineLanguage, string>;
  onLanguageChange: (language: TimelineLanguage) => void;
  onTextChange: (language: TimelineLanguage, text: string) => void;
}

export function SubtitleTextEditor({ cueNumber, language, text, onLanguageChange, onTextChange }: SubtitleTextEditorProps) {
  const [compareAll, setCompareAll] = useState(false);

  function textField(fieldLanguage: TimelineLanguage) {
    return <label className={`subtitle-language-field subtitle-language-${fieldLanguage}`} key={fieldLanguage}>
      <span>{fieldLanguage.toUpperCase()}{fieldLanguage === language ? " · PREVIEW" : ""}</span>
      <textarea
        aria-label={`${fieldLanguage.toUpperCase()} Subtitle #${cueNumber}`}
        className="timeline-textarea"
        value={text[fieldLanguage]}
        onChange={(event) => onTextChange(fieldLanguage, event.target.value)}
      />
    </label>;
  }

  return <section className="subtitle-text-editor" aria-label={`Subtitle #${cueNumber} text`}>
    <div className="subtitle-editor-toolbar">
      <div className="subtitle-preview-language">
        <span>Edit and preview language</span>
        <div className="timeline-language-tabs" role="group" aria-label="Subtitle language">
          {LANGUAGES.map((item) => <button
            type="button"
            key={item}
            aria-pressed={language === item}
            className={language === item ? "is-selected" : ""}
            onClick={() => onLanguageChange(item)}
          >{item.toUpperCase()}</button>)}
        </div>
      </div>
      <button type="button" className={`editor-button subtitle-compare-toggle${compareAll ? " is-selected" : ""}`} aria-pressed={compareAll} onClick={() => setCompareAll((value) => !value)}>
        {compareAll ? "Focused edit" : "Compare all"}
      </button>
    </div>
    {compareAll
      ? <div className="subtitle-language-grid is-comparing">{LANGUAGES.map(textField)}</div>
      : <div className="subtitle-language-grid is-focused">{textField(language)}</div>}
    <small className="editor-field-hint">{compareAll ? "All translations are visible; the preview language remains marked." : "Focused editing shows one language. Compare all to review translations side by side."}</small>
  </section>;
}
