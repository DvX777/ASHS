import { useState, useRef } from "react";
import { api } from "../api/client";
import { Btn, SectionHeader, ProgressBar, toast, Card } from "../components/common";
import styles from "./UploadPage.module.css";

type Step = 1 | 2 | 3 | 4;

export function UploadPage() {
  const [step, setStep] = useState<Step>(1);
  const [tmdbSearch, setTmdbSearch] = useState("");
  const [tmdbType, setTmdbType] = useState<"movie" | "tv">("movie");
  const [results, setResults] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [quality, setQuality] = useState(1080);
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  const [uploadId, setUploadId] = useState<number | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [, setDone] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const search = async () => {
    const r = await api.searchTmdb(tmdbSearch, tmdbType).catch(() => ({ results: [] }));
    setResults(r.results ?? []);
  };

  const initUpload = async () => {
    const r = await api.uploadInit({
      tmdb_id: selected.id,
      type: tmdbType,
      quality,
      season: tmdbType === "tv" ? season : 0,
      episode: tmdbType === "tv" ? episode : 0,
    }).catch((e: any) => { toast(e.message, "error"); return null; });
    if (r) { setUploadId(r.id); setStep(3); }
  };

  const uploadFile = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || !uploadId) return;
    setUploading(true);
    const CHUNK = 5 * 1024 * 1024; // 5MB chunks
    const total = file.size;
    let offset = 0;
    try {
      while (offset < total) {
        const chunk = file.slice(offset, offset + CHUNK);
        const fd = new FormData();
        fd.append("id", String(uploadId));
        fd.append("offset", String(offset));
        fd.append("chunk", chunk);
        await fetch("/0x/api/upload/chunk", { method: "POST", credentials: "include", body: fd });
        offset += chunk.size;
        setUploadProgress(Math.round((offset / total) * 100));
      }
      await api.uploadComplete(uploadId, "");
      setDone(true); setStep(4);
      toast("Upload complete! File added to library.", "success");
    } catch (e: any) {
      toast("Upload failed: " + e.message, "error");
    } finally { setUploading(false); }
  };

  const reset = () => {
    setStep(1); setSelected(null); setResults([]); setTmdbSearch("");
    setUploadId(null); setUploadProgress(0); setDone(false);
  };

  const TMDB_IMG = "https://image.tmdb.org/t/p/w92";

  return (
    <div className={styles.page}>
      <SectionHeader title="Manual Upload" />

      {/* Step indicators */}
      <div className={styles.steps}>
        {["Search TMDB","Configure","Upload File","Done"].map((label, i) => (
          <div key={i} className={`${styles.step} ${step > i + 1 ? styles.stepDone : step === i + 1 ? styles.stepActive : ""}`}>
            <div className={styles.stepNum}>{step > i + 1 ? "✓" : i + 1}</div>
            <span>{label}</span>
          </div>
        ))}
      </div>

      {/* Step 1: TMDB Search */}
      {step === 1 && (
        <Card>
          <div className={styles.searchRow}>
            <input
              className={styles.searchInput}
              placeholder="Search movie or TV show name..."
              value={tmdbSearch}
              onChange={(e) => setTmdbSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
            />
            <select className={styles.typeSelect} value={tmdbType} onChange={(e) => setTmdbType(e.target.value as any)}>
              <option value="movie">Movie</option>
              <option value="tv">TV Show</option>
            </select>
            <Btn variant="primary" onClick={search}>Search</Btn>
          </div>
          <div className={styles.results}>
            {results.map((r: any) => (
              <div
                key={r.id}
                className={`${styles.result} ${selected?.id === r.id ? styles.resultSelected : ""}`}
                onClick={() => { setSelected(r); setStep(2); }}
              >
                {r.poster_path && <img src={TMDB_IMG + r.poster_path} className={styles.resultPoster} alt="" />}
                <div className={styles.resultInfo}>
                  <p className={styles.resultTitle}>{r.title ?? r.name}</p>
                  <p className={styles.resultMeta}>{r.release_date?.slice(0,4) ?? r.first_air_date?.slice(0,4)} · {r.vote_average?.toFixed(1)}⭐</p>
                  <p className={styles.resultOverview}>{r.overview?.slice(0, 100)}...</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Step 2: Configure */}
      {step === 2 && selected && (
        <Card>
          <div className={styles.configHeader}>
            {selected.poster_path && <img src={TMDB_IMG + selected.poster_path} className={styles.configPoster} alt="" />}
            <div>
              <h2 className={styles.configTitle}>{selected.title ?? selected.name}</h2>
              <p className={styles.configMeta}>{selected.release_date?.slice(0,4) ?? selected.first_air_date?.slice(0,4)}</p>
            </div>
          </div>
          <div className={styles.configFields}>
            <div className={styles.field}>
              <label>Quality</label>
              <select className={styles.typeSelect} value={quality} onChange={(e) => setQuality(Number(e.target.value))}>
                <option value={1080}>1080p HD</option>
                <option value={720}>720p HD</option>
                <option value={480}>480p SD</option>
              </select>
            </div>
            {tmdbType === "tv" && (
              <>
                <div className={styles.field}>
                  <label>Season</label>
                  <input type="number" min={1} value={season} onChange={(e) => setSeason(Number(e.target.value))} className={styles.numInput} />
                </div>
                <div className={styles.field}>
                  <label>Episode</label>
                  <input type="number" min={1} value={episode} onChange={(e) => setEpisode(Number(e.target.value))} className={styles.numInput} />
                </div>
              </>
            )}
          </div>
          <div className={styles.configActions}>
            <Btn variant="ghost" onClick={() => setStep(1)}>← Back</Btn>
            <Btn variant="primary" onClick={initUpload}>Continue →</Btn>
          </div>
        </Card>
      )}

      {/* Step 3: Upload */}
      {step === 3 && (
        <Card>
          <div className={styles.dropZone} onClick={() => fileRef.current?.click()}>
            <input ref={fileRef} type="file" accept="video/*" className={styles.fileInput} onChange={uploadFile} />
            <p className={styles.dropIcon}>↑</p>
            <p className={styles.dropLabel}>Click to select file or drag & drop</p>
            <p className={styles.dropHint}>MP4, MKV, AVI supported · Max upload: 50GB</p>
          </div>
          {uploading && (
            <div className={styles.progressWrap}>
              <ProgressBar value={uploadProgress} />
              <p className={styles.progressLabel}>{uploadProgress}% uploaded</p>
            </div>
          )}
          <div className={styles.configActions}>
            <Btn variant="ghost" onClick={() => setStep(2)}>← Back</Btn>
          </div>
        </Card>
      )}

      {/* Step 4: Done */}
      {step === 4 && (
        <Card>
          <div className={styles.doneSection}>
            <div className={styles.doneIcon}>✓</div>
            <h2 className={styles.doneTitle}>Upload Complete</h2>
            <p className={styles.doneSub}>
              {selected?.title ?? selected?.name} has been added to the library and is ready to stream.
            </p>
            <Btn variant="primary" onClick={reset}>Upload Another</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}
