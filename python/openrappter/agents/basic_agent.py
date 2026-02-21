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

Single File Agent Pattern:
    One file = one agent. The metadata contract, documentation, and
    deterministic code all live in a single .py file. No config files,
    no YAML, no separate manifests. Just native Python:

        class MyAgent(BasicAgent):
            def __init__(self):
                self.name = 'MyAgent'
                self.metadata = {
                    "name": self.name,
                    "description": "What this agent does",
                    "parameters": { ... }
                }
                super().__init__(name=self.name, metadata=self.metadata)

            def perform(self, **kwargs):
                ...
"""

import copy
import hashlib
import json
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
        self.slosh_filter = None
        self.slosh_preferences = None
        self.breadcrumbs = []
        self.max_breadcrumbs = 5
        self.signal_utility = {}
        self.slosh_privacy = None
        self.slosh_debug = False
        self.on_slosh_debug = None
        self.auto_suppress_threshold = -3
        self.signal_decay = 0.9
    
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

        Accepts optional 'upstream_slush' kwarg — a dict of signals from
        a previous agent's data_slush output. These get merged into context
        so downstream agents are aware of upstream results without an LLM
        interpreting between calls.
        """
        self._user_guid = kwargs.get('user_guid')
        query = kwargs.get('query', kwargs.get('request', kwargs.get('user_input', '')))

        # Extract per-call overrides
        call_filter = kwargs.pop('_slosh_filter', None)
        call_prefs = kwargs.pop('_slosh_preferences', None)

        # Decay signal utility scores toward zero
        self._decay_signal_utility()

        effective_privacy = self.slosh_privacy

        if effective_privacy and effective_privacy.get('disabled'):
            self.context = self._build_minimal_context()
        else:
            self.context = self.slosh(query, self._user_guid)
            self._emit_debug('post-slosh', self.context)

            effective_filter = call_filter if call_filter is not None else self.slosh_filter
            if effective_filter:
                self._apply_filter(self.context, effective_filter)

            effective_prefs = call_prefs if call_prefs is not None else self.slosh_preferences
            if effective_prefs:
                self._apply_preferences(self.context, effective_prefs)

            # Auto-suppress categories with utility scores at/below threshold
            auto_suppressed = self._compute_auto_suppress()
            if auto_suppressed:
                protected_categories = (effective_filter or {}).get('include')
                to_suppress = [c for c in auto_suppressed if c not in protected_categories] if protected_categories else auto_suppressed
                if to_suppress:
                    self._apply_filter(self.context, {'exclude': to_suppress})

            self._emit_debug('post-filter', self.context)

            if effective_privacy:
                self._apply_privacy(self.context, effective_privacy)
            self._emit_debug('post-privacy', self.context)

        # Attach breadcrumbs to context
        self.context['breadcrumbs'] = list(self.breadcrumbs)

        # Merge upstream data_slush into context if provided
        upstream = kwargs.pop('upstream_slush', None)
        if upstream and isinstance(upstream, dict):
            self.context['upstream_slush'] = upstream

        kwargs['_context'] = self.context

        result = self.perform(**kwargs)

        # Extract data_slush from result for downstream chaining
        parsed = None
        try:
            parsed = json.loads(result) if isinstance(result, str) else result
            if isinstance(parsed, dict) and 'data_slush' in parsed:
                self._last_data_slush = parsed['data_slush']
            else:
                self._last_data_slush = None
        except (json.JSONDecodeError, TypeError):
            self._last_data_slush = None

        # Extract and process slosh_feedback
        if isinstance(parsed, dict) and 'slosh_feedback' in parsed:
            self._process_slosh_feedback(parsed['slosh_feedback'])

        # Record breadcrumb (newest first)
        orientation = self.context.get('orientation', {})
        breadcrumb = {
            'query': query,
            'timestamp': datetime.now().isoformat(),
            'confidence': orientation.get('confidence', 'low'),
        }
        self.breadcrumbs.insert(0, breadcrumb)
        if len(self.breadcrumbs) > self.max_breadcrumbs:
            self.breadcrumbs = self.breadcrumbs[:self.max_breadcrumbs]

        self._emit_debug('post-perform', self.context, {'result_length': len(result) if isinstance(result, str) else 0})

        return result
    
    @property
    def last_data_slush(self):
        """The data_slush output from the most recent execute() call.
        Use this to feed into the next agent's upstream_slush parameter."""
        return getattr(self, '_last_data_slush', None)
    
    def slush_out(self, *, agent_name=None, confidence=None, signals=None, **extra):
        """Build a data_slush dict for downstream chaining.
        
        Convenience method so agents don't manually construct the dict.
        Automatically includes agent name, timestamp, and context summary.
        
        Usage in perform():
            return json.dumps({
                "status": "success",
                "result": "...",
                "data_slush": self.slush_out(signals={"key": "value"})
            })
        """
        slush = {
            'source_agent': agent_name or self.name,
            'timestamp': datetime.now().isoformat(),
        }
        # Pull orientation from context if available
        if self.context and isinstance(self.context, dict):
            orientation = self.context.get('orientation', {})
            if orientation:
                slush['orientation'] = {
                    'confidence': orientation.get('confidence', 'low'),
                    'approach': orientation.get('approach', 'direct'),
                }
            temporal = self.context.get('temporal', {})
            if temporal:
                slush['temporal_snapshot'] = {
                    'time_of_day': temporal.get('time_of_day', ''),
                    'fiscal': temporal.get('fiscal', ''),
                }
        if confidence is not None:
            slush['confidence'] = confidence
        if signals:
            slush['signals'] = signals
        if extra:
            slush.update(extra)
        return slush
    
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
    
    def _apply_filter(self, context, slosh_filter):
        """Zero out excluded signal categories. include wins over exclude."""
        categories = ['temporal', 'query_signals', 'memory_echoes', 'behavioral', 'priors']

        if slosh_filter.get('include'):
            excluded = [c for c in categories if c not in slosh_filter['include']]
        elif slosh_filter.get('exclude'):
            excluded = slosh_filter['exclude']
        else:
            return

        defaults = {
            'temporal': {},
            'query_signals': {'specificity': 'low', 'hints': [], 'word_count': 0, 'is_question': False, 'has_id_pattern': False},
            'memory_echoes': [],
            'behavioral': {'prefers_brief': False, 'technical_level': 'standard', 'frequent_entities': []},
            'priors': {},
        }
        for cat in excluded:
            if cat in defaults:
                context[cat] = copy.deepcopy(defaults[cat])

    def _apply_preferences(self, context, prefs):
        """Apply preference-based signal tuning."""
        if prefs.get('suppress'):
            self._apply_filter(context, {'exclude': prefs['suppress']})
        if prefs.get('prioritize'):
            hint = f"Signal priority: {', '.join(prefs['prioritize'])}"
            context.get('orientation', {}).setdefault('hints', []).insert(0, hint)

    def _process_slosh_feedback(self, feedback):
        """Update signal utility scores from agent feedback."""
        for path in feedback.get('useful_signals', []):
            self.signal_utility[path] = self.signal_utility.get(path, 0) + 1
        for path in feedback.get('useless_signals', []):
            self.signal_utility[path] = self.signal_utility.get(path, 0) - 1

    def _compute_auto_suppress(self):
        """Compute categories to auto-suppress based on accumulated feedback scores."""
        if not self.signal_utility:
            return []

        all_categories = ['temporal', 'query_signals', 'memory_echoes', 'behavioral', 'priors']
        category_scores = {}

        for path, score in self.signal_utility.items():
            root = path.split('.')[0]
            if root in all_categories:
                category_scores[root] = category_scores.get(root, 0) + score

        return [cat for cat, score in category_scores.items() if score <= self.auto_suppress_threshold]

    def _decay_signal_utility(self):
        """Decay all signal utility scores toward zero by signal_decay factor."""
        if self.signal_decay >= 1 or not self.signal_utility:
            return

        to_delete = []
        for key, score in self.signal_utility.items():
            decayed = score * self.signal_decay
            if abs(decayed) < 0.01:
                to_delete.append(key)
            else:
                self.signal_utility[key] = decayed
        for key in to_delete:
            del self.signal_utility[key]

    def _build_minimal_context(self):
        """Build a minimal context when privacy.disabled is true."""
        return {
            'timestamp': datetime.now().isoformat(),
            'temporal': {},
            'query_signals': {'specificity': 'low', 'hints': [], 'word_count': 0, 'is_question': False, 'has_id_pattern': False},
            'memory_echoes': [],
            'behavioral': {'prefers_brief': False, 'technical_level': 'standard', 'frequent_entities': []},
            'priors': {},
            'orientation': {'confidence': 'low', 'approach': 'clarify', 'hints': [], 'response_style': 'standard'},
        }

    def _apply_privacy(self, context, privacy):
        """Apply privacy controls: redact deletes values, obfuscate replaces with hash."""
        for path in privacy.get('redact', []):
            self._set_nested_value(context, path, None)
        for path in privacy.get('obfuscate', []):
            val = self._get_nested_value(context, path)
            if val is not None:
                hash_val = hashlib.sha256(str(val).encode()).hexdigest()[:8]
                self._set_nested_value(context, path, f'[obfuscated:{hash_val}]')

    def _get_nested_value(self, obj, dot_path):
        """Walk a dot-separated path and return the value, or None."""
        parts = dot_path.split('.')
        current = obj
        for part in parts:
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                return None
        return current

    def _set_nested_value(self, obj, dot_path, value):
        """Walk a dot-separated path and set or delete the value at the leaf."""
        parts = dot_path.split('.')
        current = obj
        for part in parts[:-1]:
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                return
        if isinstance(current, dict):
            leaf = parts[-1]
            if value is None:
                current.pop(leaf, None)
            else:
                current[leaf] = value

    def _emit_debug(self, stage, context, meta=None):
        """Emit a debug event if debugging is enabled."""
        if self.slosh_debug and self.on_slosh_debug:
            self.on_slosh_debug({
                'stage': stage,
                'timestamp': datetime.now().isoformat(),
                'context': copy.deepcopy(context),
                'meta': meta,
            })

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
