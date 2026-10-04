import os
import re
import json
import pickle
import logging  # Модуль для логирования
import numpy as np
import torch
import faiss 
from sentence_transformers import SentenceTransformer, CrossEncoder
from rank_bm25 import BM25Okapi 
from typing import List, Dict, Any

class VehicleExpertEngine:
    def __init__(self, kb_data=None):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        
        self.cfg = {
            "embedder": "Qwen/Qwen3-Embedding-0.6B",
            "reranker": "BAAI/bge-reranker-v2-m3"
        }
        
        # Настройка ведения логов на диске
        logging.basicConfig(
            filename='diagnostics_history.log',
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s',
            encoding='utf-8'
        )
        
        print("Инициализация поискового ядра...")
        self.bi_encoder = SentenceTransformer(self.cfg["embedder"], device=self.device)
        self.reranker = CrossEncoder(self.cfg["reranker"], device=self.device)
        
        self.documents = []
        self.raw_data = []
        self.bm25 = None
        self.index = None
        
        if kb_data:
            self.add_knowledge_base(kb_data)

    def _validate_data(self, data: List[Dict[str, Any]]) -> bool:
        if not data or not isinstance(data, list): return False
        return all('text' in d and 'meta' in d for d in data)

    def add_knowledge_base(self, data: List[Dict[str, Any]]):
        if not self._validate_data(data):
            raise ValueError("Ошибка структуры данных: отсутствуют обязательные поля 'text' или 'meta'")

        self.raw_data = data
        self.documents = [d['text'] for d in data]
        
        print("Индексация данных...")
        self.bm25 = BM25Okapi([self._tokenize(doc) for doc in self.documents])
        embeddings = self.bi_encoder.encode(self.documents, normalize_embeddings=True)
        
        self.index = faiss.IndexFlatIP(embeddings.shape[1])
        self.index.add(embeddings.astype('float32'))
        print("Индексация завершена.")

    def _tokenize(self, text: str) -> List[str]:
        return re.findall(r'[a-zа-яё0-9]+', text.lower())

    def diagnose(self, query: str, top_n: int = 5) -> List[Dict[str, Any]]:
        q_emb = self.bi_encoder.encode([query], normalize_embeddings=True)
        _, v_indices = self.index.search(q_emb.astype('float32'), 10)
        
        bm25_scores = self.bm25.get_scores(self._tokenize(query))
        bm25_indices = np.argsort(bm25_scores)[::-1][:10]
        
        candidates = list(set(v_indices[0]) | set(bm25_indices))
        pairs = [[query, self.documents[i]] for i in candidates]
        
        rerank_scores = self.reranker.predict(pairs)
        
        results = []
        for i, idx in enumerate(candidates):
            meta = self.raw_data[idx].get("meta", {})
            health = float(meta.get("health_index", 100))
            final_score = rerank_scores[i] + (100 - health) / 200
            results.append({"text": self.documents[idx], "score": float(final_score), "meta": meta})
            
        sorted_results = sorted(results, key=lambda x: x['score'], reverse=True)[:top_n]
        
        if sorted_results:
            best_match = sorted_results[0]
            logging.info(
                f"Query: '{query}' | "
                f"Code: {best_match['meta'].get('code', 'N/A')} | "
                f"System: {best_match['meta'].get('system', 'N/A')} | "
                f"Score: {best_match['score']:.2f}"
            )
            
        return sorted_results

    def prepare_llm_context(self, query: str, top_n: int = 3) -> str:
        results = self.diagnose(query, top_n=top_n)
        
        if not results:
            return "Техническая информация по данному запросу в базе данных отсутствует."

        context_blocks = []
        for i, res in enumerate(results):
            meta = res['meta']
            block = (f"ДОКУМЕНТ #{i+1}\n"
                     f"Система: {meta.get('system', 'N/A')}\n"
                     f"Код ошибки: {meta.get('code', 'N/A')}\n"
                     f"Техническое описание: {res['text']}\n")
            context_blocks.append(block)
        
        context_str = "\n".join(context_blocks)
        
        return f"""
        Промпт для LLM:
        Используй следующие технические документы для ответа на вопрос пользователя.
        Если информации недостаточно — прямо скажи об этом. Не выдумывай.
        
        ТЕХНИЧЕСКИЙ КОНТЕКСТ
        {context_str}
        Вопрос пользователя: {query}
        Ответ:
        """