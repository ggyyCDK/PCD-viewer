"use client";

import styles from "../styles/PCDViewer.module.css";
import { usePCDViewer } from "../hooks/usePCDViewer";

const tips = ["左键拖拽：旋转", "右键拖拽：平移", "滚轮：缩放"];

function cx(...classNames: Array<string | false | undefined>) {
  return classNames.filter(Boolean).join(" ");
}

export default function PCDViewer() {
  const {
    containerRef,
    lassoCanvasRef,
    error,
    fileName,
    handleFileUpload,
    handleLassoMouseDown,
    handleLassoMouseMove,
    handleLassoMouseUp,
    hasSelection,
    highlightSelection,
    lassoAction,
    lassoMode,
    loading,
    resetSelection,
    toggleFilterMode,
    toggleHighlightMode,
  } = usePCDViewer();

  const filterButtonClass = cx(
    styles.controlButton,
    lassoMode && lassoAction === "filter"
      ? styles.dangerButton
      : styles.primaryButton,
  );
  const highlightButtonClass = cx(
    styles.controlButton,
    lassoMode && lassoAction === "highlight"
      ? styles.dangerButton
      : styles.warningButton,
  );

  return (
    <section className={styles.root}>
      <div ref={containerRef} className={styles.viewport} />

      <canvas
        ref={lassoCanvasRef}
        onMouseDown={handleLassoMouseDown}
        onMouseMove={handleLassoMouseMove}
        onMouseUp={handleLassoMouseUp}
        onMouseLeave={handleLassoMouseUp}
        className={cx(
          styles.lassoCanvas,
          lassoMode ? styles.lassoCanvasActive : styles.lassoCanvasInactive,
        )}
      />

      <div className={styles.toolbar}>
        <label className={styles.fileLabel}>
          <span>选择 PCD 文件</span>
          <input
            type="file"
            accept=".pcd"
            onChange={handleFileUpload}
            className={styles.hiddenInput}
          />
        </label>

        <button
          type="button"
          onClick={toggleFilterMode}
          className={filterButtonClass}
        >
          {lassoMode && lassoAction === "filter" ? "退出套索" : "套索选择"}
        </button>

        <button
          type="button"
          onClick={toggleHighlightMode}
          className={highlightButtonClass}
        >
          {lassoMode && lassoAction === "highlight"
            ? "退出套索"
            : "套索选中并上色"}
        </button>

        {hasSelection && (
          <button
            type="button"
            onClick={highlightSelection}
            className={cx(styles.controlButton, styles.accentButton)}
          >
            标记上色
          </button>
        )}

        {hasSelection && (
          <button
            type="button"
            onClick={resetSelection}
            className={cx(styles.controlButton, styles.successButton)}
          >
            重置选区
          </button>
        )}

        {fileName && <span className={styles.fileBadge}>{fileName}</span>}
      </div>

      {/* {lassoMode && (
        <div className={styles.lassoBanner}>套索模式：在画面上拖拽绘制选区</div>
      )} */}

      {loading && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingCard}>{loading}</div>
        </div>
      )}

      {error && <div className={styles.errorCard}>{error}</div>}

      <div className={styles.footerTips}>
        {tips.map((tip) => (
          <span key={tip} className={styles.footerTip}>
            {tip}
          </span>
        ))}
      </div>
    </section>
  );
}
