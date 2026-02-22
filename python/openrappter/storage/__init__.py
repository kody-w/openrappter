"""
openrappter Storage Package

StorageAdapter interface with in-memory and SQLite implementations.
"""

from openrappter.storage.adapter import StorageAdapter, create_storage_adapter

__all__ = [
    'StorageAdapter',
    'create_storage_adapter',
]
