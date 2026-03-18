#!/usr/bin/env python3
"""
Memory Consolidation Agent for NanoClaw

Runs every 30 minutes to find connections and patterns across stored memories.
Inspired by Google Cloud's always-on memory agent consolidation approach.

Outputs insights via IPC learn files so they get added to codified context.

Usage:
    python memory_consolidation_agent.py

Scheduled via NanoClaw task scheduler:
    cron: "*/30 * * * *", context_mode: "isolated"
"""

import json
import sqlite3
import time
from pathlib import Path
from datetime import datetime, timedelta
from typing import List, Dict, Any
import sys
import re

# Configuration
MEMORY_DB = Path("/workspace/project/store/messages.db")
CONSOLIDATION_HISTORY = Path("/workspace/group/memory_consolidations.jsonl")
IPC_TASKS_DIR = Path("/workspace/ipc/tasks")
LOOKBACK_HOURS = 24  # Process memories from last 24 hours

# Codex integration
MEMORY_MD_PATH = Path("/workspace/project/groups/main/MEMORY.md")


def parse_codified_context() -> Dict[str, List[Dict[str, str]]]:
    """
    Parse the Codified Context section from MEMORY.md.

    Returns dict of categories -> list of facts
    """
    if not MEMORY_MD_PATH.exists():
        return {}

    content = MEMORY_MD_PATH.read_text()

    # Find the Codified Context section
    match = re.search(r'## Codified Context \(Hot Cache\)(.*?)(?=\n## |\Z)', content, re.DOTALL)
    if not match:
        return {}

    section = match.group(1)

    # Parse by category (### CATEGORY_NAME)
    categories = {}
    current_category = None

    for line in section.split('\n'):
        line = line.strip()

        # Category header
        if line.startswith('### '):
            current_category = line[4:].strip().lower()
            categories[current_category] = []

        # Fact line (starts with - **)
        elif line.startswith('- **') and current_category:
            # Extract key and value
            # Format: - **key:** value (confidence)
            fact_match = re.match(r'- \*\*(.+?):\*\* (.+?)(?:\s+\((\d+)% confident\))?$', line)
            if fact_match:
                key, value, confidence = fact_match.groups()
                categories[current_category].append({
                    "key": key,
                    "value": value,
                    "confidence": int(confidence) if confidence else 80,
                    "category": current_category
                })

    return categories


def get_recent_memories(hours: int = LOOKBACK_HOURS) -> List[Dict[str, Any]]:
    """
    Read recent memories from semantic search database.

    Returns memories with: content, source, timestamp, embedding metadata
    """
    if not MEMORY_DB.exists():
        print(f"⚠️  Memory database not found at {MEMORY_DB}")
        return []

    conn = sqlite3.connect(MEMORY_DB)
    conn.row_factory = sqlite3.Row

    # Calculate cutoff time
    cutoff = datetime.now() - timedelta(hours=hours)
    cutoff_str = cutoff.isoformat()

    cursor = conn.execute("""
        SELECT id, source, content, indexed_at, group_folder
        FROM semantic_chunks
        WHERE indexed_at >= ?
        ORDER BY indexed_at DESC
        LIMIT 100
    """, (cutoff_str,))

    memories = []
    for row in cursor:
        memories.append({
            "id": row["id"],
            "source": row["source"],
            "content": row["content"],
            "created_at": row["indexed_at"],
            "group": row["group_folder"],
            "type": "semantic_chunk"
        })

    conn.close()
    return memories


def extract_entities_and_topics(memories: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Extract common entities and topics across memories.
    Simple keyword extraction - could be enhanced with NER.
    """
    # Keywords that appear frequently
    all_words = []
    for m in memories:
        content = m["content"].lower()
        # Simple word extraction (skip common words)
        words = [w.strip(".,!?") for w in content.split()
                if len(w) > 4 and w.isalnum()]
        all_words.extend(words)

    # Count frequency
    word_freq = {}
    for word in all_words:
        word_freq[word] = word_freq.get(word, 0) + 1

    # Top entities (words appearing 2+ times)
    entities = [word for word, count in sorted(word_freq.items(),
                key=lambda x: x[1], reverse=True)
                if count >= 2][:10]

    # Detect topics based on keywords
    topics = set()
    topic_keywords = {
        "lexios": ["lexios", "construction", "blueprint", "compliance", "ibc", "building"],
        "earning": ["earning", "revenue", "bounty", "clawwork", "payment", "selling"],
        "research": ["research", "analysis", "study", "findings", "data"],
        "development": ["development", "code", "implementation", "feature", "build"],
        "business": ["business", "customer", "product", "market", "opportunity"],
    }

    content_combined = " ".join([m["content"].lower() for m in memories])
    for topic, keywords in topic_keywords.items():
        if any(kw in content_combined for kw in keywords):
            topics.add(topic)

    return {
        "entities": entities,
        "topics": list(topics)
    }


def find_connections(memories: List[Dict[str, Any]],
                     metadata: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Identify relationships between memories.

    Returns list of connections: {from_id, to_id, relationship, strength}
    """
    connections = []

    # Simple approach: find memories with overlapping entities
    for i, mem1 in enumerate(memories):
        for j, mem2 in enumerate(memories[i+1:], start=i+1):
            # Check for shared keywords
            words1 = set(mem1["content"].lower().split())
            words2 = set(mem2["content"].lower().split())
            overlap = words1 & words2

            # Significant overlap (10+ shared words)
            if len(overlap) >= 10:
                # Determine relationship type
                relationship = "related_to"
                if "lexios" in overlap:
                    relationship = "lexios_related"
                elif any(w in overlap for w in ["earn", "revenue", "bounty"]):
                    relationship = "earning_related"
                elif any(w in overlap for w in ["build", "implement", "develop"]):
                    relationship = "implementation_related"

                connections.append({
                    "from_id": mem1["id"],
                    "to_id": mem2["id"],
                    "relationship": relationship,
                    "strength": min(len(overlap) / 20.0, 1.0)  # 0.0-1.0
                })

    return connections


def generate_insight(memories: List[Dict[str, Any]],
                     metadata: Dict[str, Any],
                     connections: List[Dict[str, Any]]) -> str:
    """
    Generate a key insight from the consolidated memories.
    This is where pattern recognition happens.
    Uses both semantic chunks and codex facts.
    """
    if not memories:
        return "No new memories to consolidate."

    topics = metadata.get("topics", [])
    entities = metadata.get("entities", [])

    # Separate codex facts from semantic chunks
    codex_facts = [m for m in memories if m.get("type") == "codex_fact"]
    semantic_chunks = [m for m in memories if m.get("type") == "semantic_chunk"]

    # Extract active projects from codex
    active_projects = [f for f in codex_facts if f.get("category") == "active project"]

    # Pattern detection logic
    insights = []

    # Pattern 1: Cross-domain opportunities (enhanced with codex)
    if "lexios" in topics and "earning" in topics:
        # Check if Lexios is an active project
        lexios_active = any("lexios" in f["content"].lower() for f in active_projects)
        if lexios_active:
            insights.append(
                "🔗 Connection: Lexios (active project) overlaps with earning discussions. "
                "Revenue opportunity detected."
            )
        else:
            insights.append(
                "🔗 Connection: Your Lexios knowledge overlaps with earning opportunities. "
                "Consider productizing construction compliance expertise."
            )

    # Pattern 2: Implementation readiness
    if "research" in topics and "development" in topics:
        insights.append(
            "🚀 Readiness: Research phase complete on multiple topics. "
            "Multiple findings ready for implementation."
        )

    # Pattern 3: Active project velocity
    if len(active_projects) >= 2:
        project_names = []
        for p in active_projects[:3]:
            # Extract project name from key
            key_parts = p.get("key", "").split()
            if key_parts:
                name = key_parts[0]
                project_names.append(name)

        if project_names:
            insights.append(
                f"⚡ Active Work: {len(active_projects)} projects in flight: "
                f"{', '.join(project_names[:3])}. High development velocity."
            )

    # Pattern 4: Customer validation
    if "business" in topics and len([e for e in entities if "customer" in e or "user" in e]) > 0:
        insights.append(
            "👥 Customer Signal: Multiple customer-related discussions detected. "
            "Market validation in progress."
        )

    # Pattern 5: Consolidation opportunity
    if len(connections) >= 3:
        insights.append(
            f"🧩 Knowledge Graph: Found {len(connections)} connections. "
            f"Common themes: {', '.join(topics[:3])}"
        )

    # Pattern 6: Codex-only insights (when no semantic data)
    if len(codex_facts) >= 3 and len(semantic_chunks) == 0:
        categories = set([f.get("category") for f in codex_facts])
        insights.append(
            f"🎯 Context Snapshot: {len(codex_facts)} codex facts across "
            f"{len(categories)} categories. {', '.join(list(categories)[:3])}"
        )

    # Default insight if no patterns detected
    if not insights:
        semantic_count = len(semantic_chunks)
        codex_count = len(codex_facts)
        return (
            f"📊 Activity Summary: {semantic_count} new memories, "
            f"{codex_count} codex facts. "
            f"Topics: {', '.join(topics[:3]) if topics else 'general'}."
        )

    return " | ".join(insights[:2])  # Max 2 insights to keep it concise


def store_consolidation(consolidation: Dict[str, Any]):
    """
    Store consolidation result to history file.
    """
    CONSOLIDATION_HISTORY.parent.mkdir(parents=True, exist_ok=True)

    with open(CONSOLIDATION_HISTORY, "a") as f:
        f.write(json.dumps(consolidation) + "\n")


def emit_learn_ipc(topic: str, knowledge: str, domain: str = "nanoclaw"):
    """
    Write a learn IPC file so the host picks it up and adds to codified context.

    File format matches the learn handler in src/ipc.ts:
    { type: "learn", topic: str, knowledge: str, domain: str }
    """
    IPC_TASKS_DIR.mkdir(parents=True, exist_ok=True)

    timestamp = int(time.time() * 1000)
    filename = f"learn_{timestamp}.json"

    payload = {
        "type": "learn",
        "topic": topic,
        "knowledge": knowledge,
        "domain": domain,
    }

    filepath = IPC_TASKS_DIR / filename
    filepath.write_text(json.dumps(payload))
    print(f"📤 IPC learn emitted: {filename} (topic={topic})")
    return filepath


def emit_insights_via_ipc(
    insight: str,
    stats: Dict[str, Any],
    metadata: Dict[str, Any],
    connections: List[Dict[str, Any]],
):
    """
    Convert consolidation results into learn IPC files.
    Each insight becomes a codified fact in MEMORY.md via the learn handler.
    """
    emitted = 0

    # Primary insight as a learn fact
    if insight and len(insight) >= 50:
        topic = f"consolidation-insight ({datetime.now().strftime('%Y-%m-%d %H:%M')})"
        emit_learn_ipc(topic, insight)
        emitted += 1
        time.sleep(0.01)  # Ensure unique timestamps

    # Emit topic connections if significant
    topics = stats.get("topics", [])
    if len(topics) >= 2 and stats["connections_found"] >= 3:
        knowledge = (
            f"Memory consolidation found {stats['connections_found']} connections "
            f"across {stats['memories_processed']} items. "
            f"Active themes: {', '.join(topics[:5])}. "
            f"Top entities: {', '.join(metadata.get('entities', [])[:5])}. "
            f"This indicates convergent activity across these domains."
        )
        if len(knowledge) >= 200:
            emit_learn_ipc("cross-domain-patterns", knowledge)
            emitted += 1

    print(f"📊 Consolidation: {stats['memories_processed']} items, "
          f"{stats['connections_found']} connections, {emitted} insights emitted via IPC")


def main():
    """
    Main consolidation pipeline.
    """
    print("🔄 Starting memory consolidation...")

    # 1. Read recent memories from semantic chunks
    memories = get_recent_memories(LOOKBACK_HOURS)

    # 2. Read codified context facts
    codex_facts = parse_codified_context()

    # Add codex facts as "memories" for consolidation
    for category, facts in codex_facts.items():
        for fact in facts:
            memories.append({
                "id": f"codex_{category}_{fact['key']}",
                "source": "codified_context",
                "content": f"{fact['key']}: {fact['value']}",
                "created_at": datetime.now().isoformat(),
                "group": "main",
                "type": "codex_fact",
                "category": category,
                "confidence": fact["confidence"]
            })

    print(f"📚 Found {len([m for m in memories if m.get('type') == 'semantic_chunk'])} semantic chunks")
    print(f"🧠 Found {len([m for m in memories if m.get('type') == 'codex_fact'])} codex facts")

    if len(memories) < 2:
        print(f"⏭️  Skipping consolidation: only {len(memories)} total items")
        print("Minimum 2 items required for pattern finding.")
        return

    print(f"📊 Total items to consolidate: {len(memories)}")

    # 2. Extract metadata
    metadata = extract_entities_and_topics(memories)
    print(f"🏷️  Extracted {len(metadata['entities'])} entities, {len(metadata['topics'])} topics")

    # 3. Find connections
    connections = find_connections(memories, metadata)
    print(f"🔗 Found {len(connections)} connections")

    # 4. Generate insight
    insight = generate_insight(memories, metadata, connections)
    print(f"💡 Insight: {insight}")

    # 5. Store consolidation
    consolidation = {
        "timestamp": datetime.now().isoformat(),
        "source_memory_ids": [m["id"] for m in memories],
        "memories_processed": len(memories),
        "entities": metadata["entities"],
        "topics": metadata["topics"],
        "connections": connections,
        "insight": insight,
        "lookback_hours": LOOKBACK_HOURS
    }

    store_consolidation(consolidation)
    print(f"💾 Saved to {CONSOLIDATION_HISTORY}")

    # 6. Emit insights via IPC learn handler
    stats = {
        "memories_processed": len(memories),
        "connections_found": len(connections),
        "topics": metadata["topics"],
    }

    emit_insights_via_ipc(insight, stats, metadata, connections)

    print("✅ Consolidation complete")


if __name__ == "__main__":
    main()
