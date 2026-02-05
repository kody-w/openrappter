"""
BasicAgent - Base class for all rapp agents with built-in data sloshing.

Data sloshing is IMPLICIT - every agent automatically enriches context
before performing its action. This provides:
- Temporal awareness (time of day, fiscal period, urgency signals)
- Memory echoes (relevant past interactions)
- User behavioral hints (preferences, patterns)
- Entity relationship signals
- Disambiguation priors

Subclasses just implement `perform()` - the context is already enriched.
"""

import logging
import re
from datetime import datetime
from collections import Counter


class BasicAgent:
    """
    Base class for all agents with implicit data sloshing.
    
    Every agent inherits:
    - self.context: Enriched context frame (populated before perform())
    - self.slosh(): Manual trigger for context enrichment
    - self.get_signal(key): Get specific context signal
    """
    
    def __init__(self, name, metadata):
        self.name = name
        self.metadata = metadata
        self.context = {}
        self._storage_manager = None
        self._user_guid = None
    
    @property
    def storage_manager(self):
        """Lazy-load storage manager"""
        if self._storage_manager is None:
            try:
                from openrappter.utils.storage_factory import get_storage_manager
                self._storage_manager = get_storage_manager()
            except ImportError:
                self._storage_manager = None
        return self._storage_manager
    
    def execute(self, **kwargs):
        """
        Main entry point - sloshes context then calls perform().
        Called by the orchestrator instead of perform() directly.
        """
        self._user_guid = kwargs.get('user_guid')
        query = kwargs.get('query', kwargs.get('request', kwargs.get('user_input', '')))
        
        self.context = self.slosh(query, self._user_guid)
        kwargs['_context'] = self.context
        
        return self.perform(**kwargs)
    
    def perform(self, **kwargs):
        """Override this in subclasses. Context is available via self.context"""
        pass
    
    def slosh(self, query='', user_guid=None):
        """
        Data sloshing - gather contextual signals from multiple sources.
        Returns enriched context frame.
        """
        context = {
            'timestamp': datetime.now().isoformat(),
            'temporal': self._slosh_temporal(),
            'query_signals': self._slosh_query(query),
            'memory_echoes': self._slosh_memory(query, user_guid),
            'behavioral': self._slosh_behavioral(user_guid),
            'priors': self._slosh_priors(query, user_guid),
        }
        
        context['orientation'] = self._synthesize_orientation(context)
        
        return context
    
    def get_signal(self, key, default=None):
        """Get a specific signal from the context"""
        if '.' in key:
            parts = key.split('.')
            value = self.context
            for part in parts:
                if isinstance(value, dict):
                    value = value.get(part, {})
                else:
                    return default
            return value if value != {} else default
        return self.context.get(key, default)
    
    def _slosh_temporal(self):
        """Temporal context signals"""
        now = datetime.now()
        hour = now.hour
        
        if 5 <= hour < 9:
            time_of_day = "early_morning"
            likely_activity = "preparing_for_day"
        elif 9 <= hour < 12:
            time_of_day = "morning"
            likely_activity = "active_work"
        elif 12 <= hour < 17:
            time_of_day = "afternoon"
            likely_activity = "follow_ups"
        elif 17 <= hour < 21:
            time_of_day = "evening"
            likely_activity = "wrap_up"
        else:
            time_of_day = "night"
            likely_activity = "after_hours"
        
        month, day = now.month, now.day
        if month in [1, 4, 7, 10] and day <= 15:
            fiscal = "quarter_start"
        elif month in [3, 6, 9, 12] and day >= 15:
            fiscal = "quarter_end_push"
        elif month == 12:
            fiscal = "year_end"
        else:
            fiscal = "mid_quarter"
        
        return {
            'time_of_day': time_of_day,
            'day_of_week': now.strftime("%A"),
            'is_weekend': now.weekday() >= 5,
            'quarter': f"Q{(month - 1) // 3 + 1}",
            'fiscal': fiscal,
            'likely_activity': likely_activity,
            'is_urgent_period': fiscal in ['quarter_end_push', 'year_end'],
        }
    
    def _slosh_query(self, query):
        """Extract signals from the query itself"""
        if not query:
            return {'specificity': 'low', 'hints': []}
        
        query_lower = query.lower()
        hints = []
        
        if any(w in query_lower for w in ['today', 'this morning', 'now']):
            hints.append('temporal:today')
        if any(w in query_lower for w in ['latest', 'recent', 'current', 'active']):
            hints.append('temporal:recency')
        if any(w in query_lower for w in ['yesterday', 'last week', 'previous']):
            hints.append('temporal:past')
        if re.search(r'q[1-4]', query_lower):
            hints.append('temporal:quarterly')
        
        if re.search(r'\bmy\b|\bmine\b', query_lower):
            hints.append('ownership:user')
        if re.search(r'\bour\b|\bteam\b', query_lower):
            hints.append('ownership:team')
        
        has_id = bool(re.search(r'[a-f0-9]{8}-', query_lower))
        has_number = bool(re.search(r'\b\d+\b', query_lower))
        
        if has_id:
            specificity = 'high'
        elif len(hints) >= 2 or has_number:
            specificity = 'medium'
        else:
            specificity = 'low'
        
        return {
            'specificity': specificity,
            'hints': hints,
            'word_count': len(query.split()),
            'is_question': '?' in query,
            'has_id_pattern': has_id,
        }
    
    def _slosh_memory(self, query, user_guid):
        """Find relevant memory echoes"""
        echoes = []
        
        if not self.storage_manager or not query:
            return echoes
        
        try:
            if user_guid:
                self.storage_manager.set_memory_context(user_guid)
            
            memory_data = self.storage_manager.read_json() or {}
            query_words = set(query.lower().split())
            
            for key, value in memory_data.items():
                if isinstance(value, dict) and 'message' in value:
                    message = value.get('message', '')
                    message_words = set(message.lower().split())
                    
                    overlap = len(query_words & message_words)
                    if overlap >= 2:
                        echoes.append({
                            'message': message[:80],
                            'theme': value.get('theme', 'unknown'),
                            'relevance': overlap / max(len(query_words), 1),
                        })
            
            echoes.sort(key=lambda x: x['relevance'], reverse=True)
            return echoes[:3]
            
        except Exception as e:
            logging.debug(f"Memory slosh error: {e}")
            return []
    
    def _slosh_behavioral(self, user_guid):
        """Infer behavioral patterns"""
        hints = {
            'prefers_brief': False,
            'technical_level': 'standard',
            'frequent_entities': [],
        }
        
        if not self.storage_manager:
            return hints
        
        try:
            if user_guid:
                self.storage_manager.set_memory_context(user_guid)
            
            memory_data = self.storage_manager.read_json() or {}
            
            message_lengths = []
            entity_mentions = Counter()
            technical_count = 0
            
            for key, value in memory_data.items():
                if isinstance(value, dict):
                    msg = value.get('message', '')
                    message_lengths.append(len(msg.split()))
                    
                    msg_lower = msg.lower()
                    if any(t in msg_lower for t in ['api', 'schema', 'guid', 'crud']):
                        technical_count += 1
            
            if message_lengths:
                hints['prefers_brief'] = sum(message_lengths) / len(message_lengths) < 15
            
            if technical_count > 3:
                hints['technical_level'] = 'advanced'
            elif technical_count > 0:
                hints['technical_level'] = 'intermediate'
                
        except Exception as e:
            logging.debug(f"Behavioral slosh error: {e}")
        
        return hints
    
    def _slosh_priors(self, query, user_guid):
        """Get disambiguation priors from preferences"""
        priors = {}
        
        if not self.storage_manager or not query:
            return priors
        
        try:
            if user_guid:
                self.storage_manager.set_memory_context(user_guid)
            
            memory_data = self.storage_manager.read_json() or {}
            query_lower = query.lower()
            
            for key, value in memory_data.items():
                if isinstance(value, dict) and value.get('theme') == 'preference':
                    msg = value.get('message', '').lower()
                    
                    for word in query_lower.split():
                        if len(word) > 3 and word in msg:
                            if 'prefers' in msg:
                                parts = msg.split('prefers')
                                if len(parts) > 1:
                                    preferred = parts[1].split('for')[0].strip()
                                    priors[word] = {
                                        'preferred': preferred,
                                        'confidence': 0.85,
                                    }
                                    break
        except Exception as e:
            logging.debug(f"Priors slosh error: {e}")
        
        return priors
    
    def _synthesize_orientation(self, context):
        """Synthesize signals into actionable orientation"""
        
        query_signals = context.get('query_signals', {})
        priors = context.get('priors', {})
        temporal = context.get('temporal', {})
        
        if query_signals.get('specificity') == 'high':
            confidence = 'high'
            approach = 'direct'
        elif priors:
            confidence = 'high'
            approach = 'use_preference'
        elif query_signals.get('specificity') == 'medium':
            confidence = 'medium'
            approach = 'contextual'
        else:
            confidence = 'low'
            approach = 'clarify'
        
        hints = []
        for hint in query_signals.get('hints', []):
            if hint == 'temporal:recency':
                hints.append("Sort by most recent")
            elif hint == 'ownership:user':
                hints.append("Filter by current user")
            elif hint == 'temporal:today':
                hints.append("Focus on today's items")
        
        if temporal.get('is_urgent_period'):
            hints.append("Quarter/year end - prioritize closing activities")
        
        return {
            'confidence': confidence,
            'approach': approach,
            'hints': hints,
            'response_style': 'concise' if context.get('behavioral', {}).get('prefers_brief') else 'standard',
        }
