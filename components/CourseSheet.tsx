"use client";

import { motion } from "motion/react";
import type { Course } from "@/lib/courses";
import { islandSpring } from "@/lib/motion";

export default function CourseSheet({
  course,
  onClose,
}: {
  course: Course;
  onClose: () => void;
}) {
  return (
    <motion.section
      className="course-sheet"
      aria-label="추천 코스 정보"
      initial={{ y: 48, opacity: 0, scale: 0.96 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      exit={{ y: 36, opacity: 0, scale: 0.97, transition: { duration: 0.18 } }}
      transition={islandSpring}
    >
      <button
        type="button"
        className="sheet-handle"
        aria-label="닫기"
        onClick={onClose}
      >
        <span />
      </button>
      <div className="sheet-eyebrow">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2.5c.5 3.9 2 6.6 5.5 7.5-3.5.9-5 3.6-5.5 7.5-.5-3.9-2-6.6-5.5-7.5 3.5-.9 5-3.6 5.5-7.5z" />
          <path d="M19.5 14c.3 1.8 1 3 2.5 3.4-1.5.4-2.2 1.6-2.5 3.4-.3-1.8-1-3-2.5-3.4 1.5-.4 2.2-1.6 2.5-3.4z" />
        </svg>
        {course.generated ? "방금 만든 오늘의 코스" : "추천 코스"}
      </div>
      <div className="sheet-body">
        <div className="sheet-info">
          <h2 className="sheet-title">{course.title}</h2>
          <div className="sheet-chips">
            <span className="chip">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 16.5c0-1.2.8-2.2 2-2.7l3.6-1.5 2-4.8c.3-.7 1-1.1 1.7-1 1 .1 2.5.6 3.7 2 .9 1 2.7 1.6 4 1.9.9.2 1.5 1 1.5 1.9v2.2c0 1.7-1.3 3-3 3H6c-1.7 0-3-.4-3-1zm0 3h18v1.2c0 .4-.3.8-.8.8H3.8a.8.8 0 0 1-.8-.8V19.5z" />
              </svg>
              {course.distance}
            </span>
            <span className="chip">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M12 7.5V12l3 2"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              {course.duration}
            </span>
            <span className="chip">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="#d79422">
                <rect x="4" y="13" width="4" height="7" rx="1" />
                <rect x="10" y="9" width="4" height="11" rx="1" />
                <rect x="16" y="5" width="4" height="15" rx="1" />
              </svg>
              {course.difficulty}
            </span>
            {course.ascentM != null && (
              <span className="chip">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 19 9.5 8l3.2 5.4L15 10l6 9H3z" />
                </svg>
                오르막 {Math.round(course.ascentM)}m
              </span>
            )}
          </div>
        </div>
        <div className="sheet-photo-wrap">
          <div className="sheet-photo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/assets/example-thumbnail.jpg" alt="코스 사진" draggable={false} />
          </div>
        </div>
      </div>
      <p className="sheet-desc">{course.description}</p>
      {course.waypoints?.length ? (
        <ol className="sheet-waypoints" aria-label="산책 경유지">
          {course.waypoints.map((point, index) => <li key={`${point.pathIndex}-${index}`}><span>{index + 1}</span>{point.label || "산책 경유지"}</li>)}
        </ol>
      ) : null}
      {course.notice && <p className="sheet-notice">{course.notice}</p>}
    </motion.section>
  );
}
